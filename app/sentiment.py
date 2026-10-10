"""Simple keyword sentiment (placeholder). Replace with a multilingual AI model later."""

NEGATIVE = [
    "attack", "killed", "death", "dead", "arrest", "scam", "fraud", "fake", "protest",
    "controversy", "failure", "failed", "crash", "leak", "breach", "corruption", "suicide",
    "assault", "theft", "smuggling", "threat", "bomb", "terror", "injured", "slams", "row",
    "हमला", "शव", "शहीद", "ताबूत", "मौत", "मृत", "गिरफ्तार", "घोटाला", "धोखाधड़ी", "फर्जी", "विरोध", "विवाद",
    "असफल", "नाकाम", "लीक", "भ्रष्टाचार", "आत्महत्या", "चोरी", "तस्करी", "धमकी", "बम", "आतंक", "घायल",
]
POSITIVE = [
    "success", "successful", "launch", "launches", "launched", "award", "honour", "honor", "bravery",
    "rescue", "rescued", "saves", "saved", "milestone", "historic", "praise", "appreciated", "commended",
    "wins", "achievement", "recruitment", "inaugurates",
    "बचाई", "बचाने", "बचा ली", "सफल", "सफलता", "लॉन्च", "पुरस्कार", "सम्मान", "बहादुरी", "वीरता", "बचाया", "उपलब्धि", "ऐतिहासिक", "प्रशंसा", "भर्ती",
]


def detect_language(text: str) -> str:
    return "hi" if any("ऀ" <= ch <= "ॿ" for ch in text) else "en"


def score(text: str) -> str:
    t = text.lower()
    neg = sum(1 for w in NEGATIVE if w in t)
    pos = sum(1 for w in POSITIVE if w in t)
    if neg > pos:
        return "negative"
    if pos > neg:
        return "positive"
    return "neutral"


# ---------------------------------------------------------------------------
# AI sentiment (Gemini). The keyword scorer above is only the fast fallback.
# ---------------------------------------------------------------------------
import json
import os
import time
import urllib.error
import urllib.request

AI_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"]
BATCH = 40

_PROMPT = (
    "Classify the sentiment of each news headline or social post for the reputation of the organisation it is about "
    "(CISF - Central Industrial Security Force, or ISRO - Indian space agency).\n"
    "negative = bad news: crime, attack, accident, death, corruption, scam, controversy, criticism, failure, protest, threat, "
    "allegations against personnel.\n"
    "positive = good news: achievement, successful launch or mission, rescue, bravery, award, praise, good work, recruitment or opportunity.\n"
    "Patriotic, proud, tribute, salute, celebration or motivational posts (including poems and songs about the force or the nation) are positive. "
    "A condolence or martyr tribute is negative only if it reports a death; otherwise judge the overall tone.\n"
    "neutral = routine facts, announcements, explainers, generic information with no clear good or bad.\n"
    "Headlines may be Hindi or English and may contain hashtags or emojis. "
    "Return a JSON array of strings, exactly one per headline, in the same order.\n\n"
)


def classify_batch(titles):
    """Return a list of 'negative'/'positive'/'neutral' (same length as titles), or None if the AI is unavailable."""
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key or not titles:
        return None
    body = json.dumps({
        "contents": [{"parts": [{"text": _PROMPT + "\n".join(f"{i + 1}. {t[:220]}" for i, t in enumerate(titles))}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": {"type": "ARRAY", "items": {"type": "STRING", "enum": ["negative", "positive", "neutral"]}},
            "temperature": 0,
        },
    }).encode()
    for model in AI_MODELS:
        for attempt in range(3):
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                data=body, headers={"Content-Type": "application/json", "x-goog-api-key": key})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    text = json.loads(r.read())["candidates"][0]["content"]["parts"][0]["text"]
                out = json.loads(text)
                if isinstance(out, list) and len(out) == len(titles) and all(o in ("negative", "positive", "neutral") for o in out):
                    return out
                print(f"[sentiment] {model}: bad shape ({len(out) if isinstance(out, list) else '?'} vs {len(titles)})")
            except urllib.error.HTTPError as e:
                print(f"[sentiment] {model}: HTTP {e.code}")
                if e.code == 429:
                    break          # quota used up for this model, try the next one
            except Exception as e:
                print(f"[sentiment] {model}: {e}")
            time.sleep(2 * (attempt + 1))
    return None


def rescore_pending(conn, limit=400):
    """Score not-yet-AI-scored rows with Gemini and update them. Returns number updated."""
    rows = conn.execute("SELECT id, title FROM mentions WHERE ai_scored=0 ORDER BY published DESC LIMIT ?", (limit,)).fetchall()
    done = 0
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        res = classify_batch([r["title"] for r in chunk])
        if res is None:
            break                  # try again next cycle
        conn.executemany("UPDATE mentions SET sentiment=?, ai_scored=1 WHERE id=?", [(s, r["id"]) for s, r in zip(res, chunk)])
        conn.commit()
        done += len(chunk)
    return done
