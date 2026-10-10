"""Who posted it? Finds the username / page name behind each Instagram, Facebook and X item and remembers the real link."""
import json
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from .events import log
from .resolver import UA, RateLimited, google_blocked, resolve_google_news

_FB_SKIP = {"permalink.php", "story.php", "photo.php", "photo", "photos", "watch", "video.php", "videos", "events", "share", "reel", "reels",
            "profile.php", "hashtag", "login", "sharer", "plugins", "posts", "stories", "marketplace", "gaming"}


def _instagram_oembed(post_url):
    """Public oEmbed of a public post -> author_name (the username)."""
    url = "https://www.instagram.com/api/v1/oembed/?url=" + urllib.parse.quote(post_url.split("?")[0])
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read(200000).decode("utf-8", "replace")).get("author_name") or ""


def author_for(row):
    """-> (author, real_url). author is '' when it cannot be found (so we do not keep retrying)."""
    plat, link, source = row["platform"], row["link"], row["source"] or ""
    real = link
    if "news.google.com" in link:
        real = resolve_google_news(link)
    if plat == "instagram":
        if source.startswith("@"):
            return source[1:], real
        m = re.search(r"instagram\.com/([^/?#]+)/(?:p|reel|reels|tv)/", real)
        if m and m.group(1) not in ("p", "reel", "reels", "tv"):
            return m.group(1), real
        if re.search(r"instagram\.com/(?:p|reel|reels|tv)/", real):
            return _instagram_oembed(real), real
        m = re.search(r"instagram\.com/([^/?#]+)", real)
        return (m.group(1) if m else ""), real
    if plat == "x":
        m = re.search(r"(?:x|twitter)\.com/([^/?#]+)/status", real)
        return (m.group(1) if m else ""), real
    if plat == "facebook":
        parts = [p for p in urllib.parse.urlparse(real).path.split("/") if p]
        if parts and parts[0] in ("pages", "groups") and len(parts) > 1:
            return parts[1], real
        return (parts[0] if parts and parts[0] not in _FB_SKIP else ""), real
    return "", real


def fill_authors(conn, limit=60, workers=1):
    """Look up authors for items that have none yet. Returns how many were processed."""
    if google_blocked():
        return 0
    rows = conn.execute(
        "SELECT id, platform, link, source FROM mentions WHERE author IS NULL AND platform IN ('instagram','facebook','x') "
        "ORDER BY published DESC LIMIT ?", (limit,)).fetchall()
    if not rows:
        return 0
    rows = [dict(r) for r in rows]

    import threading
    import urllib.error
    stop = threading.Event()          # set when Google says "too many requests": the rest of this batch waits for the next cycle

    def work(r):
        if stop.is_set():
            return None
        for attempt in range(2):
            try:
                a, real = author_for(r)
                time.sleep(0.4)
                return r["id"], (a or "").strip(), real
            except RateLimited:
                stop.set()
                return None
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    stop.set()
                    return None
                time.sleep(1.5)
            except Exception:
                time.sleep(1.5)
        return None                    # leave NULL: tried again on a later cycle

    done = found = 0
    with ThreadPoolExecutor(workers) as ex:
        for res in ex.map(work, rows):
            if res is None or res[1] is None:
                continue
            i, a, real = res
            conn.execute("UPDATE mentions SET author=?, real_url=? WHERE id=?", (a, real, i))
            done += 1
            found += 1 if a else 0
    conn.commit()
    if done:
        log("INFO", f"Resolved the author of {found}/{done} social posts")
    if stop.is_set():
        log("WARN", "Google asked us to slow down - the remaining authors will be looked up on later cycles")
    return done


def fill_news_links(conn, limit=80):
    """Work out the real publisher link of Google News items ahead of time, slowly, so opening a story never has to ask Google."""
    if google_blocked():
        return 0
    rows = conn.execute("SELECT id, link FROM mentions WHERE platform='news' AND link LIKE '%news.google.com%' "
                        "AND (real_url IS NULL OR real_url = '') ORDER BY published DESC LIMIT ?", (limit,)).fetchall()
    done = 0
    for r in rows:
        try:
            real = resolve_google_news(r["link"])
        except RateLimited:
            log("WARN", "Google asked us to slow down - news links will be prepared later")
            break
        except Exception:
            continue
        conn.execute("UPDATE mentions SET real_url=? WHERE id=?", (real, r["id"]))
        done += 1
    conn.commit()
    if done:
        log("INFO", f"Prepared the real link of {done} news stories")
    return done
