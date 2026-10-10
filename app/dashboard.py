"""Aggregated numbers for the command-centre dashboard, plus lazy thumbnails."""
import asyncio
import json
import re
import time
from collections import Counter
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter

from . import events
from .db import get_conn
from .enrich import LOCATIONS

router = APIRouter()
PLATFORMS = ["news", "youtube", "reddit", "instagram", "facebook", "x"]

_STOP = set("""the and for with from that this have has had are was were will would about into over after before their they them his her she
you your our not but all can out new more than also its who what when where which how why one two three four just says said say get got
amid via per been being been such these those while during against between under again once only own same other some any each both few most
likely news video videos shorts short youtube https http www com live watch full latest today breaking viral trending subscribe like share follow
reel reels post posts india indian official page tweet twitter instagram facebook reddit""".split())


def _parse_pub(s):
    """published string -> aware UTC datetime or None."""
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _where(topic="", platform="", language="", hours=0, extra=None, unit="", scope=""):
    sql, args = " WHERE 1=1", []
    for col, val in (("topic", topic), ("platform", platform), ("language", language)):
        if val:
            sql += f" AND {col}=?"
            args.append(val)
    if unit:
        sql += " AND unit LIKE ?"
        args.append(f"%,{unit},%")
    if scope:
        from .units import scope_clause
        c_sql, c_args = scope_clause(scope)
        sql += c_sql
        args += c_args
    if hours:
        sql += " AND substr(published,1,19) >= ?"
        args.append((datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S"))
    return sql, args


def _risk(c):
    if c["critical"] > 0 or c["high"] >= 3:
        return "High Risk"
    if c["high"] > 0:
        return "Increased"
    if c["medium"] >= 3:
        return "Monitoring"
    if c["medium"] > 0:
        return "Stable"
    return "Normal"


@router.get("/api/dashboard")
def dashboard(topic: str = "", platform: str = "", language: str = "", hours: int = 0, unit: str = "", scope: str = ""):
    now = datetime.now(timezone.utc)
    where, args = _where(topic, platform, language, hours, unit=unit, scope=scope)
    with get_conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT id, title, source, platform, topic, published, fetched_at, sentiment, threat, confidence, location, category, entities, enriched, unit "
            "FROM mentions" + where, args)]
        all_rows = c.execute("SELECT platform, published, fetched_at, sentiment FROM mentions").fetchall()
        total_all = len(all_rows)
        ai_done = c.execute("SELECT COUNT(*) FROM mentions WHERE enriched=1").fetchone()[0]

    uwhere, uargs = _where(topic, platform, language, hours)
    with get_conn() as c:
        ucount = Counter()
        for (u,) in c.execute("SELECT unit FROM mentions" + uwhere + " AND unit != ''", uargs):
            for name in (u or "").strip(",").split(","):
                if name:
                    ucount[name] += 1

    # ---- sentiment / threat / platform counts for the current filter ----
    sent = Counter(r["sentiment"] for r in rows)
    threat = Counter(r["threat"] for r in rows if r["threat"])
    plats = Counter(r["platform"] for r in rows)
    cats = Counter(r["category"] for r in rows if r["category"])

    # ---- change in the last 24h versus the 24h before (independent of the filter) ----
    last, prev = Counter(), Counter()
    for r in all_rows:
        d = _parse_pub(r["published"])
        if not d:
            continue
        age = (now - d).total_seconds() / 3600
        if age <= 24:
            last[r["sentiment"]] += 1
        elif age <= 48:
            prev[r["sentiment"]] += 1
    change = {k: (round((last[k] - prev[k]) * 100 / prev[k]) if prev[k] else None) for k in ("positive", "neutral", "negative")}

    # ---- sparkline per sentiment: 12 buckets across the window (or the last 12 days) ----
    nb = 12
    span_h = hours if hours else 24 * nb
    bsize = span_h / nb
    series = {k: [0] * nb for k in ("positive", "neutral", "negative")}
    for r in rows:
        d = _parse_pub(r["published"])
        if not d or r["sentiment"] not in series:
            continue
        age = (now - d).total_seconds() / 3600
        if 0 <= age < span_h:
            series[r["sentiment"]][nb - 1 - int(age // bsize)] += 1

    # ---- ingestion per hour (when WE fetched the items), last 24h ----
    hourly = [0] * 24
    for r in all_rows:
        try:
            f = datetime.strptime(r["fetched_at"][:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except Exception:
            continue
        age = (now - f).total_seconds() / 3600
        if 0 <= age < 24:
            hourly[23 - int(age)] += 1

    # ---- entities, keywords, locations ----
    ent_type = Counter()
    ent_names = Counter()
    ent_kind = {}
    words = Counter()
    loc = {}
    for r in rows:
        try:
            e = json.loads(r["entities"]) if r["entities"] else {}
        except Exception:
            e = {}
        for kind, label in (("persons", "Person"), ("orgs", "Org"), ("places", "Location"), ("events", "Event")):
            for name in e.get(kind, []):
                ent_type[label] += 1
                ent_names[name] += 1
                ent_kind[name] = label
        for w in re.findall(r"#?[A-Za-z][A-Za-z0-9_]{3,}", r["title"] or ""):
            w = w.lstrip("#").lower()
            if w not in _STOP and not w.isdigit():
                words[w] += 1
        name = r["location"]
        if name and name != "Global" and name in LOCATIONS:
            l = loc.setdefault(name, {"name": name, "lat": LOCATIONS[name][0], "lon": LOCATIONS[name][1],
                                      "count": 0, "critical": 0, "high": 0, "medium": 0, "low": 0})
            l["count"] += 1
            l[r["threat"] or "low"] += 1
    locations = sorted(loc.values(), key=lambda x: -x["count"])
    for l in locations:
        l["level"] = "critical" if l["critical"] else "high" if l["high"] else "medium" if l["medium"] else "low"
        l["status"] = _risk(l)

    # ---- alerts, sources, health ----
    alerts = sum(1 for r in rows if r["threat"] in ("critical", "high") and (_parse_pub(r["published"]) or now - timedelta(days=99)) >= now - timedelta(hours=24))
    fresh = set()
    plast = {}
    for r in all_rows:
        try:
            f = datetime.strptime(r["fetched_at"][:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except Exception:
            continue
        if (now - f).total_seconds() < 6 * 3600:
            fresh.add(r["platform"])
        if f > plast.get(r["platform"], datetime.min.replace(tzinfo=timezone.utc)):
            plast[r["platform"]] = f
    active = len(fresh)

    return {
        "total": len(rows), "total_all": total_all, "ai_done": ai_done,
        "sentiment": {k: sent.get(k, 0) for k in ("positive", "neutral", "negative")},
        "change": change, "series": series,
        "threat": {k: threat.get(k, 0) for k in ("critical", "high", "medium", "low")},
        "unclassified": sum(1 for r in rows if not r["threat"]),
        "platforms": {p: plats.get(p, 0) for p in PLATFORMS},
        "hourly": hourly, "categories": dict(cats), "units": dict(ucount),
        "platform_last": {p: (plast[p].isoformat() if p in plast else None) for p in PLATFORMS},
        "entities": {"total": sum(ent_type.values()), **{k: ent_type.get(k, 0) for k in ("Person", "Org", "Location", "Event")}},
        "top_entities": [{"name": n, "type": ent_kind[n], "count": c} for n, c in ent_names.most_common(6)],
        "keywords": [{"word": w, "count": c} for w, c in words.most_common(8)],
        "locations": locations, "alerts": alerts,
        "sources_active": active, "sources_total": len(PLATFORMS), "health": round(100 * active / len(PLATFORMS)),
        "uptime": int(time.time() - events.START),
    }


@router.get("/api/authors")
def authors(platform: str = "instagram", q: str = "", hours: int = 0, limit: int = 300):
    """Accounts that posted on a social platform, with how many items and how they read."""
    where, args = _where("", platform, "", hours)
    col = "source" if platform in ("news", "youtube", "reddit") else "author"   # outlet / channel / subreddit, or the account that posted
    with get_conn() as c:
        rows = c.execute(f"SELECT {col} AS author, sentiment, threat, published FROM mentions" + where + f" AND {col} IS NOT NULL AND {col} != ''", args).fetchall()
        unknown = c.execute("SELECT COUNT(*) FROM mentions" + where + f" AND ({col} IS NULL OR {col} = '')", args).fetchone()[0]
        total = c.execute("SELECT COUNT(*) FROM mentions" + where, args).fetchone()[0]
    acc = {}
    for r in rows:
        a = acc.setdefault(r["author"].lower(), {"author": r["author"], "count": 0, "positive": 0, "neutral": 0, "negative": 0, "alerts": 0, "last": ""})
        a["count"] += 1
        a[r["sentiment"] if r["sentiment"] in ("positive", "neutral", "negative") else "neutral"] += 1
        a["alerts"] += 1 if r["threat"] in ("critical", "high") else 0
        a["last"] = max(a["last"], r["published"] or "")
    items = sorted(acc.values(), key=lambda x: (-x["count"], x["author"].lower()))
    if q:
        items = [i for i in items if q.lower().lstrip("@") in i["author"].lower()]
    return {"total": total, "unknown": unknown, "accounts": len(acc), "items": items[:limit]}


@router.get("/api/logs")
def logs(n: int = 40):
    return events.recent(n)


# ---------------- lazy thumbnails ----------------
def _thumb(row):
    url = row["link"]
    if row["platform"] == "youtube":
        m = re.search(r"v=([\w-]{6,})", url)
        return f"https://i.ytimg.com/vi/{m.group(1)}/mqdefault.jpg" if m else None
    if row["platform"] == "news":
        import trafilatura
        from .resolver import UA, resolve_google_news
        import urllib.request
        if row.get("real_url"):
            url = row["real_url"]
        elif "news.google.com" in url:
            url = resolve_google_news(url)
            with get_conn() as c:
                c.execute("UPDATE mentions SET real_url=? WHERE id=?", (url, row["id"]))      # remember it: the viewer needs it too
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=15) as r:
            html = r.read(600000).decode("utf-8", "replace")
        meta = trafilatura.extract_metadata(html)
        return meta.image if meta and meta.image else None
    return None


@router.get("/api/thumb/{mid}")
async def thumb(mid: int):
    with get_conn() as c:
        row = c.execute("SELECT id, link, platform, image, real_url FROM mentions WHERE id=?", (mid,)).fetchone()
    if not row:
        return {"url": None}
    if row["image"] is not None:
        return {"url": row["image"] or None}
    try:
        url = await asyncio.to_thread(_thumb, dict(row))
    except Exception as e:
        from .resolver import RateLimited
        if not isinstance(e, RateLimited):
            events.log("WARN", f"thumbnail {mid}: {e}")
        return {"url": None}
    with get_conn() as c:
        c.execute("UPDATE mentions SET image=? WHERE id=?", (url or "", mid))
    return {"url": url}


# ---------------- AI daily brief ----------------
def _gemini_text(prompt, max_tokens=1800):
    import os
    import urllib.request
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        raise RuntimeError("GEMINI_API_KEY missing")
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0.3, "maxOutputTokens": max_tokens}}).encode()
    last = None
    for model in ("gemini-flash-latest", "gemini-flash-lite-latest", "gemini-flash-latest"):
        req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                                     data=body, headers={"Content-Type": "application/json", "x-goog-api-key": key})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return "".join(p.get("text", "") for p in json.loads(r.read())["candidates"][0]["content"]["parts"]).strip()
        except Exception as e:
            last = e
            time.sleep(2)
    raise last


@router.post("/api/report")
async def report(topic: str = "", hours: int = 24):
    d = dashboard(topic=topic, hours=hours)
    where, args = _where(topic, "", "", hours)
    with get_conn() as c:
        top = [dict(r) for r in c.execute(
            "SELECT title, topic, platform, sentiment, threat, location, published FROM mentions" + where +
            " AND threat IN ('critical','high') ORDER BY published DESC LIMIT 14", args)]
    lines = "\n".join(f"- [{t['threat'].upper()}] {t['title'][:150]} ({t['topic']}, {t['platform']}, {t['location']})" for t in top) or "- (no high or critical items)"
    window = f"last {hours} hours" if hours else "all collected data"
    prompt = (
        "You are the analyst of a media-monitoring control room for CISF and ISRO. Write a concise daily intelligence brief in simple Hindi (Devanagari). "
        "Use ONLY the data below; do not invent facts or numbers. Plain text, no markdown symbols like # or *. Sections, each starting with its heading on its own line: "
        "सार, मुख्य खतरे, जगहें, भावना का रुझान, सुझाव. Keep it under 250 words.\n\n"
        f"Window: {window}. Topic filter: {topic or 'CISF + ISRO'}.\n"
        f"Items: {d['total']}. Sentiment: {d['sentiment']}. Threat levels: {d['threat']}. Platforms: {d['platforms']}.\n"
        f"Top locations: {[(l['name'], l['count'], l['status']) for l in d['locations'][:6]]}.\n"
        f"Top keywords: {[k['word'] for k in d['keywords']]}. Top entities: {[e['name'] for e in d['top_entities']]}.\n"
        f"Most serious items:\n{lines}\n"
    )
    try:
        text = await asyncio.to_thread(_gemini_text, prompt)
    except Exception as e:
        events.log("WARN", f"report: {e}")
        return {"ok": False, "text": "रिपोर्ट अभी नहीं बन पाई। कुछ देर बाद फिर कोशिश कीजिए।"}
    events.log("AI", "Daily brief generated")
    return {"ok": True, "text": text, "generated": datetime.now().strftime("%d %b %Y, %H:%M"), "window": window}
