"""AI enrichment of every item with Gemini: sentiment, threat level, confidence, location, category and named entities."""
import json
import os
import time
import urllib.error
import urllib.request

from .events import log

# canonical places the model must choose from -> (lat, lon). Used for the threat map.
LOCATIONS = {
    "Delhi": (28.61, 77.21), "Mumbai": (19.08, 72.88), "Kolkata": (22.57, 88.36), "Chennai": (13.08, 80.27),
    "Bengaluru": (12.97, 77.59), "Hyderabad": (17.38, 78.49), "Ahmedabad": (23.02, 72.57), "Jaipur": (26.91, 75.79),
    "Pune": (18.52, 73.86), "Kochi": (9.93, 76.27), "Thiruvananthapuram": (8.52, 76.94), "Sriharikota": (13.72, 80.23),
    "Visakhapatnam": (17.69, 83.22), "Bhubaneswar": (20.30, 85.82), "Guwahati": (26.14, 91.74), "Ranchi": (23.34, 85.31),
    "Raipur": (21.25, 81.63), "Nagpur": (21.15, 79.09), "Lucknow": (26.85, 80.95), "Patna": (25.59, 85.14),
    "Bhopal": (23.26, 77.41), "Chandigarh": (30.73, 76.78), "Srinagar": (34.08, 74.80), "Leh": (34.15, 77.58),
    "Jammu & Kashmir": (33.9, 75.2), "Ladakh": (34.5, 77.6), "Punjab": (31.15, 75.34), "Haryana": (29.06, 76.09),
    "Uttarakhand": (30.07, 79.02), "Himachal Pradesh": (31.9, 77.2), "Uttar Pradesh": (27.2, 80.6), "Rajasthan": (26.6, 73.8),
    "Gujarat": (22.6, 71.7), "Madhya Pradesh": (23.5, 78.3), "Bihar": (25.7, 85.6), "Jharkhand": (23.7, 85.5),
    "Chhattisgarh": (21.3, 82.0), "Odisha": (20.6, 84.4), "West Bengal": (23.4, 87.9), "Assam": (26.4, 92.9),
    "Manipur": (24.8, 93.9), "Meghalaya": (25.5, 91.4), "Tripura": (23.8, 91.7), "Nagaland": (26.1, 94.5),
    "Mizoram": (23.3, 92.8), "Arunachal Pradesh": (28.0, 94.7), "Sikkim": (27.5, 88.5), "Maharashtra": (19.5, 76.0),
    "Goa": (15.3, 74.0), "Karnataka": (14.8, 75.7), "Kerala": (10.4, 76.4), "Tamil Nadu": (11.1, 78.5),
    "Andhra Pradesh": (15.9, 79.7), "Telangana": (17.9, 79.0), "Andaman & Nicobar": (11.7, 92.7),
    "Pakistan": (30.4, 69.3), "China": (34.5, 90.0), "Bangladesh": (23.7, 90.3), "Nepal": (28.3, 84.0),
    "Sri Lanka": (7.8, 80.7), "Myanmar": (21.0, 96.0), "Bhutan": (27.4, 90.4),
}
GLOBAL = "Global"
_LOW = {k.lower(): k for k in LOCATIONS}
SENT = ("negative", "positive", "neutral")
THREAT = ("critical", "high", "medium", "low")
CATS = ("protest", "defence", "space", "crime", "accident", "security", "recruitment", "achievement", "other")
BATCH = 25
MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"]

_PROMPT = (
    "You analyse news headlines and social posts about two Indian organisations: CISF (Central Industrial Security Force) and ISRO (space agency). "
    "Headlines may be Hindi, English or mixed, with hashtags and emojis. For EACH headline return one object with:\n"
    "- sentiment: negative (bad news for the organisation: crime, attack, death, accident, corruption, controversy, criticism, failure, protest), "
    "positive (achievement, successful launch, rescue, bravery, award, praise, good work, recruitment), neutral (routine facts or explainers).\n"
    "  Patriotic, proud, tribute or celebration posts are positive.\n"
    "- threat: how serious this is as a security/reputation alert. critical = deaths, terror attack, shooting, major security breach, serious accident "
    "or launch disaster; high = attack on personnel, violent protest, arrest, serious allegation, launch failure; medium = controversy, criticism, minor "
    "incident, security alert, ongoing protest; low = routine, positive or informational.\n"
    "- confidence: integer 0-100, how sure you are of the threat and sentiment.\n"
    "- location: the single best match from this list, else Global: " + ", ".join(LOCATIONS) + ".\n"
    "- category: one of " + ", ".join(CATS) + ".\n"
    "- persons, orgs, places, events: short lists of named entities found in the headline (may be empty). Use English names.\n"
    "Return a JSON array with exactly one object per headline, in the same order.\n\n"
)

_ITEM = {
    "type": "OBJECT",
    "properties": {
        "sentiment": {"type": "STRING", "enum": list(SENT)},
        "threat": {"type": "STRING", "enum": list(THREAT)},
        "confidence": {"type": "INTEGER"},
        "location": {"type": "STRING"},
        "category": {"type": "STRING", "enum": list(CATS)},
        "persons": {"type": "ARRAY", "items": {"type": "STRING"}},
        "orgs": {"type": "ARRAY", "items": {"type": "STRING"}},
        "places": {"type": "ARRAY", "items": {"type": "STRING"}},
        "events": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": ["sentiment", "threat", "confidence", "location", "category", "persons", "orgs", "places", "events"],
}


def _clean(o):
    loc = _LOW.get(str(o.get("location", "")).strip().lower(), GLOBAL)
    ents = {k: [str(x).strip()[:40] for x in (o.get(k) or []) if str(x).strip()][:6] for k in ("persons", "orgs", "places", "events")}
    return {
        "sentiment": o["sentiment"] if o.get("sentiment") in SENT else "neutral",
        "threat": o["threat"] if o.get("threat") in THREAT else "low",
        "confidence": max(0, min(100, int(o.get("confidence") or 0))),
        "location": loc,
        "category": o["category"] if o.get("category") in CATS else "other",
        "entities": ents,
    }


def enrich_batch(titles):
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key or not titles:
        return None
    body = json.dumps({
        "contents": [{"parts": [{"text": _PROMPT + "\n".join(f"{i + 1}. {t[:220]}" for i, t in enumerate(titles))}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": {"type": "ARRAY", "items": _ITEM},
                             "temperature": 0, "maxOutputTokens": 8192},
    }).encode()
    for model in MODELS:
        for attempt in range(3):
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                data=body, headers={"Content-Type": "application/json", "x-goog-api-key": key})
            try:
                with urllib.request.urlopen(req, timeout=90) as r:
                    text = json.loads(r.read())["candidates"][0]["content"]["parts"][0]["text"]
                out = json.loads(text)
                if isinstance(out, list) and len(out) == len(titles):
                    return [_clean(o) for o in out]
                log("WARN", f"AI {model}: bad shape ({len(out) if isinstance(out, list) else '?'} vs {len(titles)})")
            except urllib.error.HTTPError as e:
                log("WARN", f"AI {model}: HTTP {e.code}")
                if e.code == 429:
                    break
            except Exception as e:
                log("WARN", f"AI {model}: {e}")
            time.sleep(2 * (attempt + 1))
    return None


def enrich_pending(conn, limit=300):
    """Enrich rows not yet analysed. Returns how many were updated."""
    rows = conn.execute("SELECT id, title FROM mentions WHERE enriched=0 ORDER BY published DESC LIMIT ?", (limit,)).fetchall()
    done = 0
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        t0 = time.time()
        res = enrich_batch([r["title"] for r in chunk])
        if res is None:
            break
        conn.executemany(
            "UPDATE mentions SET sentiment=?, threat=?, confidence=?, location=?, category=?, entities=?, ai_scored=1, enriched=1 WHERE id=?",
            [(x["sentiment"], x["threat"], x["confidence"], x["location"], x["category"], json.dumps(x["entities"], ensure_ascii=False), r["id"])
             for x, r in zip(res, chunk)])
        conn.commit()
        done += len(chunk)
        log("AI", f"Analysed {len(chunk)} items (sentiment, threat, location, entities) in {time.time() - t0:.1f}s")
    return done
