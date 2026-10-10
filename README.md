# Drishti

CISF & ISRO media-intelligence command centre.

    pip install -r requirements.txt
    python -m uvicorn app.main:app --port 8765

Open http://127.0.0.1:8765

## Keys (`.env` in this folder, one `NAME=value` per line, never commit it)

| Name | Used for |
|---|---|
| `GEMINI_API_KEY` | AI analysis of every item (sentiment, threat, location, entities), the AI brief, text/voice chat |
| `YOUTUBE_API_KEY` | YouTube search |
| `APIFY_TOKEN` | Instagram hashtag posts and CISF-named Instagram accounts (paid per run; the free $5/month is small) |

## What it does

- **Collects** news (Google News + The Hindu, Indian Express, NDTV, HT), YouTube, Reddit and public Instagram / Facebook / X posts every 15 minutes.
- **Analyses** each item with Gemini: sentiment, threat level, confidence, location, category, named entities.
- **Dashboard** (`/`): live pipeline, threat map of India, sentiment and threat panels, intelligence feed, system logs, "ask Drishti AI" box. Posts open inside the centre panel, never in a new window.
- **Tabs**: AI Analytics, Threat Map, Sources (+ CISF-named Instagram accounts to watch), Reports (AI daily brief in Hindi).
- **Voice**: say "Hey Drishti" (Chrome, microphone allowed) for a spoken conversation through the Gemini Live API.

## Layout

    app/main.py        FastAPI app, collector loop, chat/TTS endpoints
    app/collector.py   fetches all sources
    app/enrich.py      Gemini enrichment (threat, location, entities ...)
    app/dashboard.py   /api/dashboard, /api/logs, /api/thumb, /api/report
    app/accounts.py    CISF-named Instagram accounts
    app/resolver.py    turns a link into something that can be shown in the panel
    app/voice.py       Gemini Live voice assistant (websocket /ws/voice)
    app/static/        index.html, app.js (dashboard), voice.js (voice client)

Set `DRISHTI_NO_COLLECT=1` to run the dashboard without fetching new items.

## Moving to another laptop

1. Install Python 3.10+ (python.org, tick "Add Python to PATH") and Google Chrome.
2. Copy the `Drishti` folder (or unzip `Drishti_portable.zip`) anywhere.
3. Double-click `setup_drishti.bat` once, then put your keys in `.env` (see `.env.example`). `.env` is never packed: copy it yourself, privately.
4. Double-click `start_drishti.bat`. It opens http://127.0.0.1:8765.

The data lives in `drishti.db` (copy it to keep your history; without it Drishti starts empty and refills).
