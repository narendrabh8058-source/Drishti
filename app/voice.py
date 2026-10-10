"""Realtime voice assistant: browser mic <-> Gemini Live API (speech to speech). The assistant can drive the WHOLE dashboard:
filters, every tab (live, analytics, threat map, sources, reports), accounts, profiles and the AI brief."""
import asyncio
import json
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types

from .collector import collect
from .db import get_conn

router = APIRouter()

LIVE_MODEL = os.environ.get("LIVE_MODEL", "models/gemini-3.1-flash-live-preview")
FILTER_KEYS = ("topic", "sentiment", "platform", "language", "q", "unit", "threat", "category", "location", "author", "hours")
PLATS = "news, youtube, reddit, instagram, facebook or x"
UNITS = "URSC, ISITE, IDSN, LPSC, LEOS, ISTRAC, DOS (Department of Space) or MOX (Mission Operations Complex)"


def _s(desc):
    return {"type": "STRING", "description": desc}


TOOLS = [{"function_declarations": [
    {"name": "navigate", "description": "Open one of the dashboard pages. live = main dashboard (it contains the threat map, pipeline and feed), analytics = AI Analytics charts, "
     "sources = Sources page (platform cards, social accounts, CISF-named accounts), reports = AI daily brief page.",
     "parameters": {"type": "OBJECT", "properties": {"tab": {"type": "STRING", "enum": ["live", "analytics", "sources", "reports"]}}, "required": ["tab"]}},
    {"name": "get_dashboard", "description": "Read the numbers: totals, sentiment, threat levels, platforms, alerts, top locations, top entities, top keywords, ISRO unit counts. "
     "Use it to answer any question about the data.",
     "parameters": {"type": "OBJECT", "properties": {"topic": _s("CISF or ISRO"), "platform": _s(PLATS), "hours": {"type": "INTEGER", "description": "only the last N hours; 0 = all time"},
                                                     "unit": _s(UNITS)}}},
    {"name": "set_filters", "description": "Filter the news feed and open the live dashboard. Pass only what the user asked for; the rest keeps its old value. clear_all resets everything.",
     "parameters": {"type": "OBJECT", "properties": {
         "topic": _s("CISF, ISRO or both comma-separated"), "sentiment": _s("negative, positive or neutral"), "platform": _s(PLATS), "language": _s("hi or en"),
         "query": _s("search words in the title"), "unit": _s("one or several ISRO units, comma-separated: " + UNITS),
         "threat": _s("critical, high, medium or low"), "category": _s("protest, defence, space, crime, accident, security, recruitment, achievement or other"),
         "location": _s("an Indian state or city, e.g. Delhi, Jammu & Kashmir, Sriharikota"), "author": _s("exact username / page name of one account"),
         "hours": {"type": "INTEGER", "description": "only the last N hours (1, 6, 24, 168 = 7 days, 720 = 30 days); 0 = all time"},
         "clear_all": {"type": "BOOLEAN"}}}},
    {"name": "read_headlines", "description": "Get the top headlines currently shown (respecting the active filters) so you can read them out.",
     "parameters": {"type": "OBJECT", "properties": {"count": {"type": "INTEGER"}}}},
    {"name": "open_item", "description": "Open the Nth item (1 = first) of the currently filtered list in the centre panel.",
     "parameters": {"type": "OBJECT", "properties": {"index": {"type": "INTEGER"}}, "required": ["index"]}},
    {"name": "close_viewer", "description": "Close the opened post / profile and return to the dashboard.", "parameters": {"type": "OBJECT", "properties": {}}},
    {"name": "show_map", "description": "Scroll the main dashboard to the threat map. view: india (default), asia (South Asia) or world (global).",
     "parameters": {"type": "OBJECT", "properties": {"view": {"type": "STRING", "enum": ["india", "asia", "world"]}}}},
    {"name": "show_source", "description": "Open the Sources page on one platform and list its accounts / outlets and posts. Optionally one specific account (username / page name / outlet / channel).",
     "parameters": {"type": "OBJECT", "properties": {"platform": _s(PLATS), "author": _s("one account, page, outlet or channel name")}, "required": ["platform"]}},
    {"name": "list_authors", "description": "Tell which accounts (Instagram/Facebook/X) or outlets/channels (news/youtube/reddit) post the most on a platform.",
     "parameters": {"type": "OBJECT", "properties": {"platform": _s(PLATS), "count": {"type": "INTEGER"}, "hours": {"type": "INTEGER"}}, "required": ["platform"]}},
    {"name": "show_cisf_accounts", "description": "Open the list of accounts whose username / name contains CISF (Instagram, Facebook, X) on the Sources page. platform optional.",
     "parameters": {"type": "OBJECT", "properties": {"platform": _s("instagram, facebook or x; empty = all")}}},
    {"name": "list_cisf_accounts", "description": "Read out the CISF-named accounts: how many per platform and the biggest ones.",
     "parameters": {"type": "OBJECT", "properties": {"platform": _s("instagram, facebook or x; empty = all"), "count": {"type": "INTEGER"}}}},
    {"name": "open_profile", "description": "Open the profile of one CISF-named account in the centre panel.",
     "parameters": {"type": "OBJECT", "properties": {"platform": _s("instagram, facebook or x"), "username": _s("the username")}, "required": ["platform", "username"]}},
    {"name": "watch_account", "description": "Put a CISF-named account on the watch list (watched=true) or take it off (false).",
     "parameters": {"type": "OBJECT", "properties": {"platform": _s("instagram, facebook or x"), "username": _s("the username"), "watched": {"type": "BOOLEAN"}},
                    "required": ["platform", "username", "watched"]}},
    {"name": "find_new_accounts", "description": "Look for new CISF-named accounts in the collected data and in Google's profile index (free, takes a few seconds).",
     "parameters": {"type": "OBJECT", "properties": {}}},
    {"name": "generate_report", "description": "Create the AI daily intelligence brief and show it on the Reports page. Returns the text so you can summarise it aloud.",
     "parameters": {"type": "OBJECT", "properties": {"topic": _s("CISF or ISRO; empty = both"), "hours": {"type": "INTEGER", "description": "24 = last day (default), 168 = last week, 0 = all data"}}}},
    {"name": "refresh_news", "description": "Fetch the latest news and posts from all sources right now.", "parameters": {"type": "OBJECT", "properties": {}}},
    {"name": "end_session", "description": "Call when the user says goodbye, thanks, stop, or wants you to go to sleep. Say a short goodbye first.",
     "parameters": {"type": "OBJECT", "properties": {}}},
]}]


def _where(f):
    sql, args = "WHERE 1=1", []
    for col in ("sentiment", "language", "platform", "threat", "category", "location"):
        if f.get(col):
            sql += f" AND {col}=?"
            args.append(f[col])
    if f.get("q"):
        sql += " AND title LIKE ?"
        args.append(f"%{f['q']}%")
    scope = ",".join(x for x in (str(f.get("topic") or ""), str(f.get("unit") or "")) if x)      # several may be named: ANY of them
    if scope:
        from .units import scope_clause
        c_sql, c_args = scope_clause(scope)
        sql += c_sql
        args += c_args
    if f.get("author"):
        sql += " AND author = ? COLLATE NOCASE"
        args.append(str(f["author"]).lstrip("@"))
    if f.get("hours"):
        sql += " AND substr(published,1,19) >= ?"
        args.append((datetime.now(timezone.utc) - timedelta(hours=int(f["hours"]))).strftime("%Y-%m-%dT%H:%M:%S"))
    return sql, args


def _stats(f):
    sql, args = _where(f)
    with get_conn() as c:
        rows = c.execute(f"SELECT sentiment, COUNT(*) n FROM mentions {sql} GROUP BY sentiment", args).fetchall()
    d = {r["sentiment"]: r["n"] for r in rows}
    return {"total": sum(d.values()), "negative": d.get("negative", 0), "positive": d.get("positive", 0), "neutral": d.get("neutral", 0)}


def _items(f, n):
    sql, args = _where(f)
    with get_conn() as c:
        return [dict(r) for r in c.execute(f"SELECT * FROM mentions {sql} ORDER BY published DESC LIMIT ?", args + [n])]


def _system_prompt():
    now = datetime.now()
    s = _stats({})
    return (
        "You are Drishti (दृष्टि), the female voice assistant of a CISF and ISRO media-intelligence command centre. "
        "Speak natural, warm, fluent spoken Hindi (Devanagari), like a real person, in short sentences. "
        "Always address the user respectfully as 'सर'. Never use markdown, lists or emojis.\n"
        f"Now: {now.strftime('%A, %d %B %Y, %I:%M %p')}. "
        f"Database right now: total {s['total']} items - {s['negative']} negative, {s['positive']} positive, {s['neutral']} neutral.\n"
        "When the conversation starts (the user has just said 'Hey Drishti'), do this in one go: say 'जय हिंद सर', "
        "tell the current time and today's date in Hindi, tell the total number of items with the negative, positive and neutral counts, "
        "then ask what they would like you to do.\n"
        "You can operate EVERYTHING in this website by voice, using tools:\n"
        "- Pages: navigate(live | analytics | sources | reports). 'AI Analytics / चार्ट' = analytics, 'Sources / स्रोत' = sources, 'Reports / रिपोर्ट' = reports, "
        "'डैशबोर्ड / वापस' = live (and close_viewer if something is open). The threat map is on the main dashboard: 'Threat Map / नक्शा' = show_map.\n"
        "- Feed: set_filters for sentiment, threat level (critical/high/medium/low), platform (news, youtube, reddit, instagram, facebook, x), topic (CISF, ISRO), "
        "ISRO units (URSC, ISITE, IDSN, LPSC, LEOS, ISTRAC, DOS, MOX), category, location (a state or city), a time window (hours) or one account. "
        "read_headlines reads the news aloud, open_item opens the Nth one in the centre panel, close_viewer closes it.\n"
        "- Numbers and questions about the data: get_dashboard (totals, sentiment, threats, alerts, top locations, entities, keywords). "
        "Call it with NO arguments for a question about everything; only pass topic / platform / hours / unit when the user names them in THAT question - "
        "never carry over filters from an earlier command.\n"
        "- Sources: show_source(platform, optional account) opens the posts of a platform or of one account; list_authors says who posts the most.\n"
        "- CISF-named accounts: show_cisf_accounts, list_cisf_accounts, open_profile, watch_account, find_new_accounts.\n"
        "- Reports: generate_report creates the Hindi daily brief and shows it on the Reports page; then give a very short spoken summary. refresh_news fetches fresh news.\n"
        "Always do what the user asks by calling the tool, then tell them in one short sentence what you did, with the key number. "
        "Never read out long lists: at most three items unless asked. Answer general questions directly and briefly. "
        "When the user says goodbye, thanks or stop, say 'जय हिंद सर' and call end_session."
    )


@router.websocket("/ws/voice")
async def voice(ws: WebSocket):
    await ws.accept()
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        await ws.send_json({"type": "error", "text": "GEMINI_API_KEY .env में नहीं मिली।"})
        await ws.close()
        return

    filters = {k: "" for k in FILTER_KEYS}
    client = genai.Client(api_key=key)
    cfg = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        output_audio_transcription={},
        input_audio_transcription={},
        system_instruction=_system_prompt(),
        tools=TOOLS,
        speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=os.environ.get("LIVE_VOICE", "Kore")))),
    )

    async def ui(**event):
        await ws.send_json(event)

    async def run_tool(name, a):
        from . import accounts as acc
        from . import dashboard as dash
        if name == "navigate":
            await ui(type="tab", tab=a.get("tab", "live"))
            return {"opened": a.get("tab", "live")}
        if name == "get_dashboard":
            d = await asyncio.to_thread(dash.dashboard, a.get("topic", ""), a.get("platform", ""), "", int(a.get("hours") or 0), a.get("unit", ""))
            return {"total": d["total"], "sentiment": d["sentiment"], "threat_levels": d["threat"], "platforms": d["platforms"], "alerts_24h_high_or_critical": d["alerts"],
                    "top_locations": [{"name": l["name"], "items": l["count"], "status": l["status"]} for l in d["locations"][:6]],
                    "top_entities": [e["name"] for e in d["top_entities"][:5]], "top_keywords": [k["word"] for k in d["keywords"][:6]],
                    "isro_units": d["units"], "categories": d["categories"], "sources_active": f"{d['sources_active']}/{d['sources_total']}"}
        if name == "set_filters":
            if a.get("clear_all"):
                filters.update({k: "" for k in FILTER_KEYS})
            for k in FILTER_KEYS:
                v = a.get("query") if k == "q" else a.get(k)
                if v not in (None, ""):
                    filters[k] = v
            if "hours" in a and not a["hours"]:
                filters["hours"] = ""
            await ui(type="filters", filters=filters)
            return {"applied": {k: v for k, v in filters.items() if v}, **_stats(filters)}
        if name == "read_headlines":
            items = _items(filters, max(1, min(int(a.get("count") or 3), 6)))
            return {"headlines": [f"{i + 1}. {m['title']} ({m['platform']}, {m['sentiment']})" for i, m in enumerate(items)]}
        if name == "open_item":
            items = _items(filters, 30)
            i = int(a.get("index") or 1) - 1
            if not 0 <= i < len(items):
                return {"error": "no such item"}
            m = items[i]
            await ui(type="open", id=m["id"], title=m["title"], platform=m["platform"], link=m["link"])
            return {"opened": m["title"]}
        if name == "close_viewer":
            await ui(type="close")
            return {"closed": True}
        if name == "show_map":
            await ui(type="map", view=a.get("view") or "india")
            return {"showing": a.get("view") or "india"}
        if name == "show_source":
            await ui(type="source", platform=a.get("platform", "instagram"), author=a.get("author", ""))
            res = await asyncio.to_thread(dash.authors, a.get("platform", "instagram"), "", 0, 5)
            return {"platform": a.get("platform"), "accounts": res["accounts"], "posts": res["total"], "top": [(i["author"], i["count"]) for i in res["items"][:3]]}
        if name == "list_authors":
            res = await asyncio.to_thread(dash.authors, a.get("platform", "instagram"), "", int(a.get("hours") or 0), 20)
            n = max(1, min(int(a.get("count") or 5), 10))
            return {"platform": a.get("platform"), "accounts": res["accounts"], "posts": res["total"], "top": [{"name": i["author"], "posts": i["count"], "alerts": i["alerts"]} for i in res["items"][:n]]}
        if name == "show_cisf_accounts":
            await ui(type="accounts", platform=a.get("platform", ""))
            d = await asyncio.to_thread(acc.list_accounts, "", a.get("platform", ""), 0, 1)
            return {"by_platform": d["by_platform"], "total": d["total"]}
        if name == "list_cisf_accounts":
            d = await asyncio.to_thread(acc.list_accounts, "", a.get("platform", ""), 0, 200)
            n = max(1, min(int(a.get("count") or 5), 10))
            return {"by_platform": d["by_platform"], "watching": d["watching"],
                    "biggest": [{"platform": i["platform"], "username": i["username"], "followers": i["followers"], "posts_we_hold": i["posts"]} for i in
                                sorted(d["items"], key=lambda x: -(x["followers"] or 0))[:n]]}
        if name == "open_profile":
            plat, user = a.get("platform", "instagram"), str(a.get("username", "")).lstrip("@")
            await ui(type="profile", platform=plat, username=user, url=acc.PROFILE_URL.get(plat, "").format(u=user))
            return {"opened": f"{plat} @{user}"}
        if name == "watch_account":
            plat, user = a.get("platform", "instagram"), str(a.get("username", "")).lstrip("@").lower()
            with get_conn() as c:
                n = c.execute("UPDATE accounts SET watched=? WHERE platform=? AND username=?", (int(bool(a.get("watched"))), plat, user)).rowcount
            await ui(type="accounts", platform=plat)
            return {"ok": bool(n), "watched": bool(a.get("watched")), "note": "" if n else "no such account in the list"}
        if name == "find_new_accounts":
            def run():
                with get_conn() as c:
                    new = acc.accounts_from_posts(c) + acc.search_profiles(c)
                    c.commit()
                    return new
            new = await asyncio.to_thread(run)
            await ui(type="accounts", platform="")
            return {"new_accounts_found": new}
        if name == "generate_report":
            r = await dash.report(a.get("topic", "") or "", int(24 if a.get("hours") is None else a.get("hours")))
            await ui(type="report", text=r["text"], meta=(f"GENERATED {r.get('generated', '')} · {r.get('window', '')}" if r.get("ok") else ""))
            return {"ok": r.get("ok"), "report": r["text"][:1400]}
        if name == "refresh_news":
            n = await asyncio.to_thread(collect)
            await ui(type="refresh")
            return {"new_items": n, **_stats({})}
        if name == "end_session":
            return {"ok": True}
        return {"error": "unknown tool"}

    try:
        async with client.aio.live.connect(model=LIVE_MODEL, config=cfg) as session:
            await ws.send_json({"type": "ready"})
            await session.send_realtime_input(text="(The user just said: Hey Drishti. Begin now.)")
            ending = False

            async def mic_to_gemini():
                while True:
                    msg = await ws.receive()
                    if msg.get("type") == "websocket.disconnect":
                        return
                    if msg.get("bytes"):
                        await session.send_realtime_input(
                            audio=types.Blob(data=msg["bytes"], mime_type="audio/pcm;rate=16000"))
                    elif msg.get("text") == "stop":
                        return
                    elif msg.get("text", "").startswith("say:"):
                        await session.send_realtime_input(text=msg["text"][4:])

            async def gemini_to_browser():
                nonlocal ending
                while True:
                    async for m in session.receive():
                        sc = m.server_content
                        if sc:
                            if sc.interrupted:
                                await ws.send_json({"type": "interrupted"})
                            if sc.model_turn:
                                for p in sc.model_turn.parts:
                                    if p.inline_data and p.inline_data.data:
                                        await ws.send_bytes(p.inline_data.data)
                            if sc.input_transcription and sc.input_transcription.text:
                                await ws.send_json({"type": "you", "text": sc.input_transcription.text})
                            if sc.output_transcription and sc.output_transcription.text:
                                await ws.send_json({"type": "bot", "text": sc.output_transcription.text})
                            if sc.turn_complete:
                                await ws.send_json({"type": "turn_complete"})
                                if ending:
                                    await ws.send_json({"type": "end"})
                                    return
                        if m.tool_call:
                            responses = []
                            for fc in m.tool_call.function_calls:
                                try:
                                    out = await run_tool(fc.name, dict(fc.args or {}))
                                except Exception as e:
                                    print(f"[voice] tool {fc.name}: {e}")
                                    out = {"error": str(e)}
                                if fc.name == "end_session":
                                    ending = True
                                responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response=out))
                            await session.send_tool_response(function_responses=responses)

            tasks = [asyncio.create_task(mic_to_gemini()), asyncio.create_task(gemini_to_browser())]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            for t in done:
                if t.exception():
                    raise t.exception()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[voice] {type(e).__name__}: {e}")
        try:
            await ws.send_json({"type": "error", "text": "आवाज़ वाली सेवा से जुड़ नहीं पाया।"})
        except Exception:
            pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass
