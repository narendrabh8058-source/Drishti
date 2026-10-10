"""A small in-memory log of what the backend actually does (shown as 'System Logs' on the dashboard)."""
import time
from collections import deque
from datetime import datetime

START = time.time()
_BUF = deque(maxlen=400)


def log(level, msg):
    _BUF.append({"t": datetime.now().strftime("%H:%M:%S"), "ts": time.time(), "level": level, "msg": msg})
    print(f"[{level}] {msg}")


def recent(n=60):
    return list(_BUF)[-n:]
