import json
import os
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from pathlib import Path

from .db import get_conn
from .events import log
from .units import fill_units
from .authors import fill_authors, fill_news_links
from .enrich import enrich_pending
from .sentiment import detect_language, rescore_pending, score

def _load_env():
    path = Path(__file__).resolve().parent.parent / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "")

# topic -> keywords used for searching and for filtering general news feeds
TOPICS = {
    "CISF": ["CISF", "Central Industrial Security Force", "सीआईएसएफ"],
    "ISRO": ["ISRO", "Indian Space Research Organisation", "इसरो"],
}

# ISRO centres and units. The acronyms are short and ambiguous (LEOS, ISITE, LPSC are also ordinary words / other bodies), so they are always
# searched together with "ISRO", and matched case-sensitively when a general news feed is filtered.
ISRO_CENTRES = ["URSC", "IDSN", "LPSC", "LEOS", "ISITE", "ISTRAC"]
CENTRE_NAMES = ["U R Rao Satellite Centre", "Indian Deep Space Network", "Liquid Propulsion Systems Centre",
                "Laboratory for Electro-Optics Systems", "ISRO Satellite Integration and Test Establishment",
                "ISRO Telemetry, Tracking and Command Network", "Department of Space", "Mission Operations Complex"]


def _search_terms(topic, kws):
    extra = [f"{c} ISRO" for c in ISRO_CENTRES] + ['"Department of Space" ISRO', '"Mission Operations Complex" ISRO']
    return list(kws) + (extra if topic == "ISRO" else [])


# (topic, query, hl, ceid) for Google News
GNEWS_QUERIES = [
    ("CISF", "CISF", "en-IN", "IN:en"),
    ("CISF", '"Central Industrial Security Force"', "en-IN", "IN:en"),
    ("CISF", "सीआईएसएफ", "hi", "IN:hi"),
    ("ISRO", "ISRO", "en-IN", "IN:en"),
    ("ISRO", '"Indian Space Research Organisation"', "en-IN", "IN:en"),
    ("ISRO", "इसरो", "hi", "IN:hi"),
]

# General news RSS feeds; items are kept only when they mention a topic keyword
NEWS_FEEDS = [
    ("The Hindu", "https://www.thehindu.com/news/national/feeder/default.rss"),
    ("The Hindu", "https://www.thehindu.com/sci-tech/science/feeder/default.rss"),
    ("Indian Express", "https://indianexpress.com/section/india/feed/"),
    ("NDTV", "https://feeds.feedburner.com/ndtvnews-india-news"),
    ("Hindustan Times", "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml"),
]

GNEWS_QUERIES += [("ISRO", f"{c} ISRO", "en-IN", "IN:en") for c in ISRO_CENTRES]
GNEWS_QUERIES += [("ISRO", f'"{n}"', "en-IN", "IN:en") for n in CENTRE_NAMES]
GNEWS_QUERIES += [("ISRO", '"Department of Space" ISRO', "en-IN", "IN:en"), ("ISRO", '"Mission Operations Complex" ISRO', "en-IN", "IN:en"),
                  ("ISRO", "अंतरिक्ष विभाग", "hi", "IN:hi")]


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 Drishti"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()


def _title_key(title):
    # Google News titles end with " - Source"; strip it and normalise for de-duplication
    base = re.sub(r"\s+-\s+[^-]+$", "", title)
    return re.sub(r"\W+", "", base.lower())


def _match_topic(text):
    low = text.lower()
    for topic, kws in TOPICS.items():
        for k in kws:
            if k.isascii():
                if re.search(r"\b" + re.escape(k.lower()) + r"\b", low):
                    return topic
            elif k in text:
                return topic
    for a in ISRO_CENTRES:                       # case-sensitive on purpose
        if re.search(r"\b" + a + r"\b", text):
            return "ISRO"
    low = text.lower()
    if any(n.lower() in low for n in CENTRE_NAMES):
        return "ISRO"
    return None


def _parse_date(s):
    try:
        return parsedate_to_datetime(s).isoformat()
    except Exception:
        return s or None


def _rss_items(url):
    root = ET.fromstring(_get(url))
    for item in root.iter("item"):
        src_el = item.find("source")
        yield {
            "title": (item.findtext("title") or "").strip(),
            "link": (item.findtext("link") or "").strip(),
            "source": src_el.text if src_el is not None else None,
            "published": _parse_date(item.findtext("pubDate")),
        }


def _google_news():
    for topic, query, hl, ceid in GNEWS_QUERIES:
        url = f"https://news.google.com/rss/search?q={urllib.parse.quote(query)}&hl={hl}&gl=IN&ceid={ceid}"
        try:
            for it in _rss_items(url):
                yield {**it, "topic": topic, "platform": "news"}
        except Exception as e:
            print(f"[collector] gnews {query}: {e}")


def _news_feeds():
    for name, url in NEWS_FEEDS:
        try:
            for it in _rss_items(url):
                topic = _match_topic(it["title"])
                if topic:
                    yield {**it, "source": it["source"] or name, "topic": topic, "platform": "news"}
        except Exception as e:
            print(f"[collector] feed {name}: {e}")


def _social_via_google():
    """Public Instagram / Facebook / X posts indexed by Google (no official API gives this)."""
    for platform, site in (("instagram", "instagram.com"), ("facebook", "facebook.com"), ("x", "x.com")):
        for topic, kws in TOPICS.items():
            for kw in _search_terms(topic, kws):
                q = f"{kw} site:{site}"
                url = f"https://news.google.com/rss/search?q={urllib.parse.quote(q)}&hl=en-IN&gl=IN&ceid=IN:en"
                try:
                    for it in _rss_items(url):
                        title = re.sub(r"\s+-\s+" + re.escape(site) + r"$", "", it["title"])
                        if platform == "x" and re.match(r"^.{0,60}\(@\w+\)\s*$", title):
                            continue        # a bare profile page, not a post
                        yield {**it, "title": title, "source": site, "topic": topic, "platform": platform}
                except Exception as e:
                    print(f"[collector] {platform} {kw}: {e}")


APIFY_TOKEN = os.environ.get("APIFY_TOKEN", "")
APIFY_EVERY_HOURS = 72   # one hashtag run costs ~$0.22 of Apify credit; every 3 days keeps a month inside the free $5
APIFY_HASHTAGS = {
    "CISF": ["cisf", "cisfindia", "सीआईएसएफ"],
    "ISRO": ["isro", "isroindia", "इसरो"],
}
APIFY_POSTS_PER_HASHTAG = 30


def _apify_due(conn):
    from datetime import datetime, timedelta, timezone
    row = conn.execute("SELECT value FROM meta WHERE key='apify_last_run'").fetchone()
    if not row:
        return True
    return datetime.now(timezone.utc) - datetime.fromisoformat(row[0]) >= timedelta(hours=APIFY_EVERY_HOURS)


def _apify_instagram(conn):
    """Public Instagram posts per hashtag (incl. ordinary users) via Apify; runs at most once a day."""
    from datetime import datetime, timezone
    if not APIFY_TOKEN or not _apify_due(conn):
        return
    # Mark the attempt first so a failing run can't burn credit every 15 minutes.
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('apify_last_run', ?)",
                 (datetime.now(timezone.utc).isoformat(),))
    conn.commit()
    for topic, tags in APIFY_HASHTAGS.items():
        body = json.dumps({"hashtags": tags, "resultsLimit": APIFY_POSTS_PER_HASHTAG}).encode()
        req = urllib.request.Request(
            "https://api.apify.com/v2/acts/apify~instagram-hashtag-scraper/run-sync-get-dataset-items",
            data=body,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {APIFY_TOKEN}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=280) as r:
                posts = json.loads(r.read())
        except Exception as e:
            print(f"[collector] apify instagram {topic}: {e}")
            continue
        for p in posts:
            caption = (p.get("caption") or "").strip().replace("\n", " ")
            link = p.get("url") or ""
            if not caption or not link:
                continue
            user = p.get("ownerUsername")
            yield {
                "title": caption[:280],
                "link": link,
                "source": f"@{user}" if user else "instagram.com",
                "published": p.get("timestamp"),
                "topic": topic,
                "platform": "instagram",
            }


def _reddit():
    ns = {"a": "http://www.w3.org/2005/Atom"}
    for topic, kws in TOPICS.items():
        q = " OR ".join(f'"{k}"' for k in kws if k.isascii())
        url = f"https://www.reddit.com/search.rss?q={urllib.parse.quote(q)}&sort=new"
        try:
            root = ET.fromstring(_get(url))
            for e in root.findall("a:entry", ns):
                link_el = e.find("a:link", ns)
                sub = e.find("a:category", ns)
                yield {
                    "title": (e.findtext("a:title", namespaces=ns) or "").strip(),
                    "link": link_el.get("href") if link_el is not None else "",
                    "source": "r/" + sub.get("term") if sub is not None else "Reddit",
                    "published": e.findtext("a:updated", namespaces=ns),
                    "topic": topic,
                    "platform": "reddit",
                }
        except Exception as e:
            print(f"[collector] reddit {topic}: {e}")


def _youtube():
    if not YOUTUBE_API_KEY:
        return
    for topic, kws in TOPICS.items():
        for kw in kws:
            params = urllib.parse.urlencode({
                "part": "snippet", "q": kw, "type": "video", "order": "date",
                "maxResults": 25, "regionCode": "IN", "key": YOUTUBE_API_KEY,
            })
            try:
                data = json.loads(_get(f"https://www.googleapis.com/youtube/v3/search?{params}"))
                for v in data.get("items", []):
                    sn = v["snippet"]
                    yield {
                        "title": sn["title"].replace("&#39;", "'").replace("&quot;", '"').replace("&amp;", "&"),
                        "link": f"https://www.youtube.com/watch?v={v['id']['videoId']}",
                        "source": sn.get("channelTitle"),
                        "published": sn.get("publishedAt"),
                        "topic": topic,
                        "platform": "youtube",
                    }
            except Exception as e:
                print(f"[collector] youtube {kw}: {e}")


def collect():
    """Fetch all sources, store new items. Returns number of new mentions."""
    new = 0
    per = {}
    log("INFO", "Collection cycle started")
    with get_conn() as conn:
        for gen in (_google_news, _news_feeds, _reddit, _youtube, _social_via_google, lambda: _apify_instagram(conn)):
            for it in gen():
                if not it["title"] or not it["link"]:
                    continue
                try:
                    cur = conn.execute(
                        "INSERT OR IGNORE INTO mentions (title, link, title_key, source, language, topic, published, sentiment, platform)"
                        " VALUES (?,?,?,?,?,?,?,?,?)",
                        (it["title"], it["link"], _title_key(it["title"]), it["source"], detect_language(it["title"]),
                         it["topic"], it["published"], score(it["title"]), it["platform"]),
                    )
                    new += cur.rowcount
                    per[it["platform"]] = per.get(it["platform"], 0) + cur.rowcount
                except Exception as e:
                    print(f"[collector] insert error: {e}")
        conn.commit()
        fill_units(conn)
        try:
            fill_authors(conn, limit=60)
            fill_news_links(conn, limit=80)
        except Exception as e:
            log("WARN", f"authors: {e}")
        for plat, n in sorted(per.items()):
            if n:
                log("INFO", f"{plat}: ingested {n} new item(s)")
        try:
            from .accounts import search_accounts
            a = search_accounts(conn)
            if a:
                print(f"[collector] {a} new CISF-named Instagram accounts")
        except Exception as e:
            print(f"[collector] accounts: {e}")
        try:
            n = enrich_pending(conn, limit=300)
            if not n:
                rescore_pending(conn, limit=0)
        except Exception as e:
            log("WARN", f"enrichment: {e}")
    log("INFO", f"Collection cycle done: {new} new item(s)")
    return new
