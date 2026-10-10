import asyncio
import json
import os
import time
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi import Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .collector import collect
from .db import get_conn, init_db
from .resolver import build_view
from .voice import router as voice_router
from .accounts import router as accounts_router
from .dashboard import router as dashboard_router

STATIC = Path(__file__).resolve().parent / "static"
INTERVAL_SECONDS = 15 * 60


async def _loop():
    if os.environ.get("DRISHTI_NO_COLLECT"):
        return          # for testing: serve the dashboard without fetching
    while True:
        n = await asyncio.to_thread(collect)
        print(f"[collector] {n} new mentions")
        await asyncio.sleep(INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app):
    init_db()
    from .units import fill_units
    with get_conn() as c:
        fill_units(c)
    task = asyncio.create_task(_loop())
    yield
    task.cancel()


app = FastAPI(title="Drishti", lifespan=lifespan)
app.include_router(voice_router)
app.include_router(accounts_router)
app.include_router(dashboard_router)


@app.get("/api/mentions")
def mentions(topic: str = "", sentiment: str = "", language: str = "", platform: str = "", source: str = "", q: str = "",
             threat: str = "", category: str = "", location: str = "", unit: str = "", author: str = "", alerts: int = 0, scope: str = "", hours: int = 0, limit: int = 100):
    sql, args = "SELECT * FROM mentions WHERE 1=1", []
    for col, val in (("topic", topic), ("sentiment", sentiment), ("language", language), ("platform", platform), ("source", source),
                     ("threat", threat), ("category", category), ("location", location)):
        if val:
            sql += f" AND {col}=?"
            args.append(val)
    if q:
        sql += " AND title LIKE ?"
        args.append(f"%{q}%")
    if unit:
        sql += " AND unit LIKE ?"
        args.append(f"%,{unit},%")
    if scope:
        from .units import scope_clause
        c_sql, c_args = scope_clause(scope)
        sql += c_sql
        args += c_args
    if alerts:                      # the "Alerts" number in the header: high + critical items of the last 24 hours
        from datetime import datetime as _dt, timedelta as _td, timezone as _tz
        sql += " AND threat IN ('critical','high') AND substr(published,1,19) >= ?"
        args.append((_dt.now(_tz.utc) - _td(hours=24)).strftime("%Y-%m-%dT%H:%M:%S"))
    if author:
        sql += " AND author = ? COLLATE NOCASE"
        args.append(author.lstrip("@"))
    if hours:
        from datetime import datetime, timedelta, timezone
        sql += " AND substr(published,1,19) >= ?"
        args.append((datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S"))
    sql += " ORDER BY published DESC LIMIT ?"
    args.append(min(limit, 500))
    with get_conn() as c:
        return [dict(r) for r in c.execute(sql, args)]


@app.get("/api/stats")
def stats():
    with get_conn() as c:
        rows = c.execute("SELECT sentiment, COUNT(*) n FROM mentions GROUP BY sentiment").fetchall()
        total = c.execute("SELECT COUNT(*) FROM mentions").fetchone()[0]
    return {"total": total, **{r["sentiment"]: r["n"] for r in rows}}


class ChatIn(BaseModel):
    message: str
    history: list[dict] = []


def _ask_gemini(system, message, history, key, model):
    contents = [
        {"role": "user" if m["role"] == "user" else "model", "parts": [{"text": m["content"]}]}
        for m in history[-6:] if m.get("role") in ("user", "assistant") and m.get("content")
    ]
    contents.append({"role": "user", "parts": [{"text": message}]})
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        data=json.dumps({
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": contents,
            "generationConfig": {"maxOutputTokens": 400},
        }).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
    )
    with urllib.request.urlopen(req, timeout=40) as r:
        data = json.loads(r.read())
    return "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"]).strip()


def _ask_openai(message, history):
    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    key = os.environ.get("OPENAI_API_KEY", "")
    if not key and not gemini_key:
        return "AI की key अभी जुड़ी नहीं है। कृपया dot env फ़ाइल में GEMINI API KEY डालिए।"
    with get_conn() as c:
        rows = c.execute("SELECT sentiment, COUNT(*) n FROM mentions GROUP BY sentiment").fetchall()
        recent = c.execute(
            "SELECT title, topic, platform, sentiment FROM mentions ORDER BY published DESC LIMIT 8"
        ).fetchall()
    counts = ", ".join(f"{r['sentiment']}: {r['n']}" for r in rows)
    headlines = "\n".join(f"- [{r['topic']}/{r['platform']}/{r['sentiment']}] {r['title']}" for r in recent)
    system = (
        "You are Drishti, a voice assistant for a CISF and ISRO media-monitoring dashboard. "
        "Always reply in simple spoken Hindi (Devanagari), in at most 3 short sentences, with no markdown or lists. "
        f"Dashboard data now - sentiment counts ({counts}). Latest items:\n{headlines}"
    )
    if gemini_key:
        models = [os.environ.get("GEMINI_MODEL", "gemini-flash-latest")] * 2 + ["gemini-flash-lite-latest"]
        for i, model in enumerate(models):
            try:
                return _ask_gemini(system, message, history, gemini_key, model)
            except Exception as e:
                print(f"[chat] gemini {model}: {e}")
                time.sleep(1.5 * (i + 1))
        if not key:
            return "माफ़ कीजिए सर, AI से जवाब नहीं मिल पाया।"
    msgs = [{"role": "system", "content": system}]
    msgs += [m for m in history[-6:] if m.get("role") in ("user", "assistant") and m.get("content")]
    msgs.append({"role": "user", "content": message})
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps({"model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"), "messages": msgs, "max_tokens": 250}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read())["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"[chat] {e}")
        return "माफ़ कीजिए सर, ChatGPT से जवाब नहीं मिल पाया।"


class TtsIn(BaseModel):
    text: str


_tts_cache: dict[str, bytes] = {}


def _wav_from_pcm(pcm, rate=24000):
    import io, wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm)
    return buf.getvalue()


def _edge_tts(text):
    import edge_tts

    async def run():
        data = b""
        comm = edge_tts.Communicate(text, os.environ.get("EDGE_VOICE", "hi-IN-SwaraNeural"))
        async for ch in comm.stream():
            if ch["type"] == "audio":
                data += ch["data"]
        return data

    data = asyncio.run(run())
    if not data:
        raise RuntimeError("edge-tts returned no audio")
    return data


def _tts(text):
    import base64
    text = text.strip()[:900]
    if text in _tts_cache:
        return _tts_cache[text]
    try:
        audio = _edge_tts(text)
        if len(_tts_cache) > 200:
            _tts_cache.clear()
        _tts_cache[text] = audio
        return audio
    except Exception as e:
        print(f"[tts] edge: {e}")
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        raise RuntimeError("no gemini key")
    body = {
        "contents": [{"parts": [{"text": text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": os.environ.get("TTS_VOICE", "Kore")}}},
        },
    }
    models = [os.environ.get("TTS_MODEL", "gemini-3.8-flash-tts"), "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"]
    last = None
    for model in dict.fromkeys(models):
        for attempt in range(2):
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json", "x-goog-api-key": key},
            )
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    part = json.loads(r.read())["candidates"][0]["content"]["parts"][0]["inlineData"]
                audio = base64.b64decode(part["data"])
                if "wav" not in part.get("mimeType", ""):
                    audio = _wav_from_pcm(audio)
                if len(_tts_cache) > 200:
                    _tts_cache.clear()
                _tts_cache[text] = audio
                return audio
            except Exception as e:
                last = e
                print(f"[tts] {model}: {e}")
                if getattr(e, "code", 0) == 429:
                    break  # quota used up for this model - go to the next one
                time.sleep(1)
    raise last


@app.post("/api/tts")
async def tts(body: TtsIn):
    try:
        audio = await asyncio.to_thread(_tts, body.text)
    except Exception:
        return Response(status_code=503)
    return Response(content=audio, media_type="audio/wav" if audio[:4] == b"RIFF" else "audio/mpeg")


@app.post("/api/chat")
async def chat(body: ChatIn):
    return {"reply": await asyncio.to_thread(_ask_openai, body.message, body.history)}


@app.get("/api/view/{mention_id}")
async def view(mention_id: int):
    with get_conn() as c:
        row = c.execute("SELECT * FROM mentions WHERE id=?", (mention_id,)).fetchone()
    if not row:
        return Response(status_code=404)
    row = dict(row)
    out = await asyncio.to_thread(build_view, row)
    if out.get("original") and out["original"] != row["link"] and not row.get("real_url"):
        with get_conn() as c:
            c.execute("UPDATE mentions SET real_url=? WHERE id=?", (out["original"], mention_id))
    return out


@app.post("/api/collect")
async def collect_now():
    return {"new": await asyncio.to_thread(collect)}


class NoCacheStatic(StaticFiles):
    """Always hand out the current script/style files; the browser must never reuse an old copy."""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-store"
        return resp


app.mount("/static", NoCacheStatic(directory=STATIC), name="static")


@app.get("/")
def index():
    from fastapi.responses import HTMLResponse
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    # a new URL for every change of the scripts, so an old cached copy can never be used
    for name in ("app.js", "voice.js"):
        v = int((STATIC / name).stat().st_mtime)
        html = html.replace(f'src="/static/{name}"', f'src="/static/{name}?v={v}"')
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})
