import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


def _open(req, timeout=20):
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


class RateLimited(Exception):
    """Google said 'too many requests'. Nothing else should ask Google until the pause is over."""


_gate = threading.Lock()
_last_call = [0.0]
_BLOCK = {"until": 0.0}
MIN_GAP = 1.2            # seconds between two requests to Google
PAUSE = 15 * 60          # how long we stay quiet after Google says stop


def google_blocked():
    return time.time() < _BLOCK["until"]


def resolve_google_news(link):
    """Turn a news.google.com/rss/articles/<id> redirect link into the publisher URL (politely: spaced out, and silent while Google is angry)."""
    if google_blocked():
        raise RateLimited("Google is rate-limiting us")
    with _gate:
        wait = MIN_GAP - (time.time() - _last_call[0])
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.time()
    try:
        return _resolve_google_news(link)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            _BLOCK["until"] = time.time() + PAUSE
            raise RateLimited("Google is rate-limiting us") from e
        raise


def _resolve_google_news(link):
    art_id = urllib.parse.urlparse(link).path.rstrip("/").split("/")[-1]
    page = _open(urllib.request.Request(
        f"https://news.google.com/rss/articles/{art_id}?hl=en-IN&gl=IN&ceid=IN:en",
        headers={"User-Agent": "Mozilla/5.0"}))
    sg = re.search(r'data-n-a-sg="([^"]+)"', page)
    ts = re.search(r'data-n-a-ts="([^"]+)"', page)
    if not (sg and ts):
        raise RuntimeError("signature not found")
    inner = ["garturlreq", [["X", "X", ["X", "X"], None, None, 1, 1, "US:en", None, 1, None, None, None, None, None, 0, 1],
                            "X", "X", 1, [1, 1, 1], 1, 1, None, 0, 0, None, 0], art_id, ts.group(1), sg.group(1)]
    body = "f.req=" + urllib.parse.quote(json.dumps([[["Fbv4je", json.dumps(inner), None, "generic"]]]))
    resp = _open(urllib.request.Request(
        "https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je",
        data=body.encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": "Mozilla/5.0"}))
    parsed = json.loads(resp.split("\n\n")[1])
    return json.loads(parsed[0][2])[1]


UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"


def _embed_for(url):
    """Return an iframe-able URL for a social/video link, or None."""
    u = urllib.parse.urlparse(url)
    host, path = u.netloc.lower(), u.path
    if "youtube.com" in host or "youtu.be" in host:
        vid = urllib.parse.parse_qs(u.query).get("v", [None])[0] or (path.strip("/") if "youtu.be" in host else None)
        return f"https://www.youtube.com/embed/{vid}?autoplay=1&rel=0" if vid else None
    if "instagram.com" in host:
        m = re.search(r"/(p|reel|reels|tv)/([\w-]+)", path)
        return f"https://www.instagram.com/{'reel' if m.group(1) == 'reels' else m.group(1)}/{m.group(2)}/embed/" if m else None
    if "facebook.com" in host or "fb.watch" in host:
        href = urllib.parse.quote(url, safe="")
        if re.search(r"/(videos|watch|reel)/|fb\.watch", url):
            return f"https://www.facebook.com/plugins/video.php?href={href}&show_text=true&width=560"
        if re.search(r"/(posts|photos|permalink|story)", url):
            return f"https://www.facebook.com/plugins/post.php?href={href}&show_text=true&width=560"
        return None
    if host in ("x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"):
        m = re.search(r"/status(?:es)?/(\d+)", path)
        return f"https://platform.twitter.com/embed/Tweet.html?id={m.group(1)}&theme=dark&dnt=true" if m else None
    if "reddit.com" in host and "/comments/" in path:
        return f"https://www.redditmedia.com{path}?ref_source=embed&embed=true"
    return None


def _article(url):
    import trafilatura
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "hi-IN,hi;q=0.9,en;q=0.8"})
    with urllib.request.urlopen(req, timeout=20) as r:
        html = r.read().decode("utf-8", "replace")
    text = trafilatura.extract(html, include_comments=False, include_tables=False)
    meta = trafilatura.extract_metadata(html)
    return {
        "title": meta.title if meta and meta.title else None,
        "image": meta.image if meta else None,
        "site": meta.sitename if meta else None,
        "text": text,
    }


_view_cache = {}


def build_view(row):
    """row: mention dict. Returns what the in-page viewer should show."""
    key = row["id"]
    if key in _view_cache:
        return _view_cache[key]
    url = row.get("real_url") or row["link"]
    out = {"title": row["title"], "original": url, "kind": "link"}
    try:
        if "news.google.com" in url:
            url = resolve_google_news(url)
            out["original"] = url
        embed = _embed_for(url)
        if embed:
            out.update(kind="embed", embed=embed, platform=row.get("platform"))
        elif row.get("platform") in ("instagram", "facebook", "youtube", "reddit", "x"):
            out["note"] = "यह पोस्ट पेज के अंदर नहीं खुल सकती। मूल पेज बटन से खोलिए।"
        else:
            art = _article(url)
            if art["text"] and len(art["text"]) > 200:
                out.update(kind="article", **{k: v for k, v in art.items() if v})
                out["title"] = art["title"] or row["title"]
            else:
                out["note"] = "इस साइट का लेख यहाँ नहीं दिखाया जा सका। मूल पेज बटन से खोलिए।"
    except RateLimited:
        out["note"] = ("Google अभी कुछ देर के लिए नए अनुरोध रोक रहा है (बहुत ज़्यादा खोले गए थे), इसलिए यह खबर यहाँ नहीं खुल पाई। "
                       "10-15 मिनट बाद फिर कोशिश कीजिए, या नीचे के बटन से इसे नए टैब में खोलिए।")
        return out                      # not cached: it will work once Google calms down
    except Exception as e:
        print(f"[view] {url}: {e}")
        out["note"] = "यह पेज अभी खुल नहीं पाया। नए टैब में खोलें बटन से खोलिए।"
    if out["kind"] != "link":
        _view_cache[key] = out
    return out
