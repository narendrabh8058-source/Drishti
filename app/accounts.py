"""Accounts (Instagram, Facebook, X) whose username or name carries the CISF name - discovery + a manual watch list."""
import json
import os
import re
import urllib.request
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter
from pydantic import BaseModel

from .db import get_conn

router = APIRouter()

# Words searched on Instagram's user search; only accounts whose username (or display name) contains MATCH are kept.
# Instagram's user search favours usernames that START with the word, so we also search the shapes that put it
# in the middle or at the end ("_cisf", "cisf fauji" -> fauji_amit_cisf, narendra_cisf ...).
SEARCH_TERMS = [
    "cisf", "_cisf", "cisf_", "cisf official", "central industrial security force",
    "cisf fauji", "cisf jawan", "cisf force", "cisf boy", "cisf girl", "cisf officer", "cisf aspirant",
]
# First names are searched a few per day in rotation ("rahul cisf" finds rahul_cisf), to keep Apify credit use low.
NAME_TERMS = [
    "rahul", "amit", "rohit", "vikas", "sunil", "anil", "ravi", "sanjay", "ajay", "vijay", "manoj", "deepak",
    "pankaj", "suresh", "ramesh", "mahesh", "narendra", "rajesh", "sachin", "ankit", "aman", "akash", "mohit",
    "sumit", "pradeep", "arun", "nitin", "vishal", "kuldeep", "rakesh", "yogesh", "dinesh", "satish", "mukesh",
    "ashok", "naveen", "pawan", "gaurav", "harish", "jitendra", "lalit", "manish", "neeraj", "prakash", "rajat",
    "santosh", "shiv", "tarun", "umesh", "vinod", "priya", "pooja", "neha", "anjali", "komal", "sonu", "monu",
    "golu", "raju", "babu", "singh", "kumar", "yadav", "sharma", "verma", "gupta", "thakur", "rajput", "jat",
]
NAMES_PER_DAY = 6
# What the automatic weekly run searches. The long lists above are used only by the manual button (deep=True).
AUTO_TERMS = ["cisf", "_cisf", "cisf fauji"]
MATCH = re.compile(r"cisf", re.I)
ACCOUNTS_EVERY_HOURS = 24 * 7   # automatic run: weekly (each search costs ~$0.14 of Apify credit)
SEARCH_LIMIT = 100


PLATFORMS = ("instagram", "facebook", "x")
PROFILE_URL = {"instagram": "https://www.instagram.com/{u}/", "facebook": "https://www.facebook.com/{u}", "x": "https://x.com/{u}"}


def init_accounts(conn):
    cols = [r[1] for r in conn.execute("PRAGMA table_info(accounts)")]
    if cols and "platform" not in cols:                      # old table: Instagram only, keyed by username
        conn.execute("ALTER TABLE accounts RENAME TO accounts_old")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS accounts (
            platform TEXT NOT NULL DEFAULT 'instagram',
            username TEXT NOT NULL,
            full_name TEXT,
            followers INTEGER,
            verified INTEGER,
            private INTEGER,
            source TEXT,
            first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
            last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
            watched INTEGER DEFAULT 0,
            PRIMARY KEY (platform, username)
        )"""
    )
    if conn.execute("SELECT name FROM sqlite_master WHERE name='accounts_old'").fetchone():
        conn.execute("INSERT OR IGNORE INTO accounts (platform, username, full_name, followers, verified, private, source, first_seen, last_seen, watched) "
                     "SELECT 'instagram', username, full_name, followers, verified, private, source, first_seen, last_seen, watched FROM accounts_old")
        conn.execute("DROP TABLE accounts_old")


def _upsert(conn, username, full_name=None, followers=None, verified=None, private=None, source="search", platform="instagram"):
    username = (username or "").strip().lstrip("@").lower()
    if not username or not (MATCH.search(username) or MATCH.search(full_name or "")):
        return 0
    if platform == "x" and not re.fullmatch(r"\w{1,15}", username):      # X handles: letters, digits, underscore, max 15 (so no web addresses)
        return 0
    cur = conn.execute(
        "INSERT OR IGNORE INTO accounts (platform, username, full_name, followers, verified, private, source) VALUES (?,?,?,?,?,?,?)",
        (platform, username, full_name, followers, None if verified is None else int(bool(verified)),
         None if private is None else int(bool(private)), source),
    )
    if not cur.rowcount:  # already known: refresh the facts we got now, keep what we had if this source has none
        conn.execute(
            "UPDATE accounts SET full_name=COALESCE(?,full_name), followers=COALESCE(?,followers), "
            "verified=COALESCE(?,verified), private=COALESCE(?,private), last_seen=CURRENT_TIMESTAMP WHERE platform=? AND username=?",
            (full_name or None, followers, None if verified is None else int(bool(verified)),
             None if private is None else int(bool(private)), platform, username),
        )
    return cur.rowcount


def accounts_from_posts(conn):
    """CISF-named accounts that show up in what we already collected: who posted, and who gets @mentioned."""
    new = 0
    for r in conn.execute("SELECT DISTINCT platform, author FROM mentions WHERE platform IN ('instagram','facebook','x') AND author LIKE '%cisf%'").fetchall():
        new += _upsert(conn, r["author"], source="post", platform=r["platform"])
    for r in conn.execute("SELECT DISTINCT source FROM mentions WHERE platform='instagram' AND source LIKE '@%cisf%'").fetchall():
        new += _upsert(conn, r["source"], source="post", platform="instagram")
    for r in conn.execute("SELECT platform, title FROM mentions WHERE platform IN ('instagram','facebook','x') AND title LIKE '%@%' AND lower(title) LIKE '%cisf%'"):
        for h in re.findall(r"@([A-Za-z0-9_.]*[Cc][Ii][Ss][Ff][A-Za-z0-9_.]*)", r["title"]):
            new += _upsert(conn, h.rstrip("."), source="mention", platform=r["platform"])
    return new


# Free discovery of Facebook / X / Instagram profiles: the pages Google indexes for "CISF". Titles look like  "Name (@handle) ..."
PROFILE_QUERIES = {
    "x": ["CISF site:x.com", "CISF official site:x.com", "CISF airport site:x.com", "CISF delhi metro site:x.com", "central industrial security force site:x.com"],
    "facebook": ["CISF site:facebook.com", "CISF official site:facebook.com", "central industrial security force site:facebook.com"],
    "instagram": ["CISF site:instagram.com", "CISF official site:instagram.com"],
}


def search_profiles(conn):
    from urllib.parse import quote
    from .collector import _rss_items
    new = 0
    for plat, queries in PROFILE_QUERIES.items():
        for q in queries:
            try:
                for it in _rss_items(f"https://news.google.com/rss/search?q={quote(q)}&hl=en-IN&gl=IN&ceid=IN:en"):
                    m = re.search(r"^(.*?)\s*\(@([\w.]+)\)", it["title"])
                    if m:
                        new += _upsert(conn, m.group(2), m.group(1).strip() or None, source="google", platform=plat)
            except Exception as e:
                print(f"[accounts] profile search '{q}': {e}")
        conn.commit()
    return new


def _due(conn):
    row = conn.execute("SELECT value FROM meta WHERE key='accounts_last_run'").fetchone()
    return not row or datetime.now(timezone.utc) - datetime.fromisoformat(row[0]) >= timedelta(hours=ACCOUNTS_EVERY_HOURS)


def search_accounts(conn, force=False, deep=False):
    """Ask Apify's Instagram user search for CISF-named accounts. At most once a day unless forced."""
    token = os.environ.get("APIFY_TOKEN", "")
    new = accounts_from_posts(conn)
    row = conn.execute("SELECT value FROM meta WHERE key='profiles_last_run'").fetchone()
    if force or not row or datetime.now(timezone.utc) - datetime.fromisoformat(row[0]) >= timedelta(hours=24):
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('profiles_last_run', ?)", (datetime.now(timezone.utc).isoformat(),))
        conn.commit()
        new += search_profiles(conn)
    if not token or not (force or _due(conn)):
        return new
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('accounts_last_run', ?)",
                 (datetime.now(timezone.utc).isoformat(),))
    conn.commit()
    terms = list(AUTO_TERMS)
    if deep:
        idx_row = conn.execute("SELECT value FROM meta WHERE key='accounts_name_idx'").fetchone()
        idx = int(idx_row[0]) if idx_row else 0
        names = [NAME_TERMS[(idx + i) % len(NAME_TERMS)] + " cisf" for i in range(NAMES_PER_DAY)]
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('accounts_name_idx', ?)", (str((idx + NAMES_PER_DAY) % len(NAME_TERMS)),))
        conn.commit()
        terms = SEARCH_TERMS + names
    for term in terms:
        req = urllib.request.Request(
            "https://api.apify.com/v2/acts/apify~instagram-search-scraper/run-sync-get-dataset-items",
            data=json.dumps({"search": term, "searchType": "user", "searchLimit": SEARCH_LIMIT}).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=290) as r:
                results = json.loads(r.read())
        except Exception as e:
            print(f"[accounts] apify '{term}': {e}")
            continue
        for u in results:
            new += _upsert(conn, u.get("username"), u.get("fullName"), u.get("followersCount"),
                           u.get("verified"), u.get("private"), source="search", platform="instagram")
        conn.commit()
    return new


@router.get("/api/accounts")
def list_accounts(q: str = "", platform: str = "", watched: int = 0, limit: int = 500):
    sql = "SELECT a.* FROM accounts a WHERE 1=1"
    args = []
    if platform:
        sql += " AND a.platform=?"
        args.append(platform)
    if q:
        sql += " AND (a.username LIKE ? OR a.full_name LIKE ?)"
        args += [f"%{q}%", f"%{q}%"]
    if watched:
        sql += " AND a.watched=1"
    with get_conn() as c:
        rows = [dict(r) for r in c.execute(sql, args)]
        by = {r["platform"]: r["n"] for r in c.execute("SELECT platform, COUNT(*) n FROM accounts GROUP BY platform")}
        watching = c.execute("SELECT COUNT(*) FROM accounts WHERE watched=1").fetchone()[0]
        # how many collected items each account has - one pass over the items, not one search per account
        posts, last = {}, {}
        for g in c.execute("SELECT platform, lower(author) a, lower(source) s, COUNT(*) n, MAX(published) lp FROM mentions "
                           "WHERE platform IN ('instagram','facebook','x') GROUP BY platform, lower(author), lower(source)"):
            keys = {g["a"]} if g["a"] else set()
            if g["s"] and g["s"].startswith("@"):
                keys.add(g["s"][1:])
            for k in keys:
                key = (g["platform"], k)
                posts[key] = posts.get(key, 0) + g["n"]
                last[key] = max(last.get(key, ""), g["lp"] or "")
    for r in rows:
        key = (r["platform"], r["username"].lower())
        r["posts"] = posts.get(key, 0)
        r["last_post"] = last.get(key) or None
        r["url"] = PROFILE_URL.get(r["platform"], "").format(u=r["username"])
    rows.sort(key=lambda r: (-r["watched"], -r["posts"], -(r["followers"] if r["followers"] is not None else -1)))
    return {"total": sum(by.values()), "by_platform": by, "watching": watching, "items": rows[:min(limit, 1000)]}


@router.get("/api/accounts/posts")
def account_posts(platform: str = "", sentiment: str = "", q: str = "", limit: int = 100):
    """Public posts written by the CISF-named accounts, optionally only the happy / neutral / sad ones (the AI's reading of the post's tone)."""
    with get_conn() as c:
        known = {(r["platform"], r["username"].lower()) for r in c.execute("SELECT platform, username FROM accounts")}
        sql = ("SELECT id, title, link, real_url, platform, source, author, published, sentiment FROM mentions "
               "WHERE platform IN ('instagram','facebook','x') AND ((author IS NOT NULL AND author != '') OR source LIKE '@%')")
        args = []
        if platform:
            sql += " AND platform=?"
            args.append(platform)
        if sentiment:
            sql += " AND sentiment=?"
            args.append(sentiment)
        if q:
            sql += " AND title LIKE ?"
            args.append(f"%{q}%")
        sql += " ORDER BY published DESC"
        out, counts = [], {"positive": 0, "neutral": 0, "negative": 0}
        for r in c.execute(sql, args):
            who = (r["author"] or (r["source"] or "").lstrip("@")).lower()
            if (r["platform"], who) not in known:
                continue
            d = dict(r)
            d["author"] = r["author"] or (r["source"] or "").lstrip("@")
            out.append(d)
        total = len(out)
        # how the (unfiltered-by-mood) set splits, for the mood buttons
        base = ("SELECT sentiment, author, source, platform FROM mentions WHERE platform IN ('instagram','facebook','x') "
                "AND ((author IS NOT NULL AND author != '') OR source LIKE '@%')")
        bargs = []
        if platform:
            base += " AND platform=?"
            bargs.append(platform)
        for r in c.execute(base, bargs):
            who = (r["author"] or (r["source"] or "").lstrip("@")).lower()
            if (r["platform"], who) in known and r["sentiment"] in counts:
                counts[r["sentiment"]] += 1
    return {"total": total, "mood_counts": counts, "items": out[:min(limit, 300)]}


class WatchIn(BaseModel):
    watched: bool


@router.post("/api/accounts/{platform}/{username}/watch")
def watch(platform: str, username: str, body: WatchIn):
    with get_conn() as c:
        c.execute("UPDATE accounts SET watched=? WHERE platform=? AND username=?", (int(body.watched), platform, username.lower()))
    return {"ok": True}


_running = {"on": False}


@router.post("/api/accounts/refresh")
async def refresh(deep: int = 0):
    import asyncio
    if _running["on"]:
        return {"started": False, "running": True}

    def run():
        _running["on"] = True
        try:
            with get_conn() as c:
                n = search_accounts(c, force=True, deep=bool(deep))
            print(f"[accounts] manual search done, {n} new")
        except Exception as e:
            print(f"[accounts] manual search failed: {e}")
        finally:
            _running["on"] = False

    asyncio.get_running_loop().run_in_executor(None, run)
    return {"started": True, "running": True}


@router.get("/api/accounts/status")
def status():
    return {"running": _running["on"]}
