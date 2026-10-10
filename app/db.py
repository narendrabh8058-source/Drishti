import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "drishti.db"


def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=60)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_conn() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS mentions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                link TEXT NOT NULL UNIQUE,
                title_key TEXT NOT NULL UNIQUE,
                source TEXT,
                language TEXT,
                topic TEXT,
                published TEXT,
                sentiment TEXT,
                fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_pub ON mentions(published)")
        from .accounts import init_accounts
        init_accounts(c)
        c.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
        cols = [r["name"] for r in c.execute("PRAGMA table_info(mentions)")]
        if "ai_scored" not in cols:
            c.execute("ALTER TABLE mentions ADD COLUMN ai_scored INTEGER DEFAULT 0")
        for col, ddl in (("threat", "TEXT"), ("confidence", "INTEGER"), ("location", "TEXT"), ("category", "TEXT"),
                         ("entities", "TEXT"), ("image", "TEXT"), ("enriched", "INTEGER DEFAULT 0"), ("unit", "TEXT"), ("author", "TEXT"), ("real_url", "TEXT")):
            if col not in cols:
                c.execute(f"ALTER TABLE mentions ADD COLUMN {col} {ddl}")
        if "platform" not in cols:
            c.execute("ALTER TABLE mentions ADD COLUMN platform TEXT DEFAULT 'news'")
