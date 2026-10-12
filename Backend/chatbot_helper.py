"""
Shared chatbot logic for the student / faculty / admin assistants.

Answer order:
  1. chatbot_faqs table        -> strict match, answered straight from the database
  2. (existing keyword logic in each *_routes.py: attendance, fees, timetable ...)
  3. chatbot_knowledge table   -> strong title match, answered from the database
  4. Gemini (main)  ->  OpenAI (backup, only if OPENAI_API_KEY is set)
  5. Friendly "could not answer" message

Keys are read from Backend/.env:
  GEMINI_API_KEY   (required for AI fallback)
  GEMINI_MODEL     (optional, default gemini-3.5-flash-lite then other 3.x models)
  OPENAI_API_KEY   (optional backup)
  OPENAI_MODEL     (optional, default gpt-4o-mini)
Uses only the Python standard library for the AI calls - nothing new to pip install.
"""
import os
import re
import json
import time
import urllib.request
import urllib.error
from functools import wraps
from flask import request
from dotenv import load_dotenv

from db import get_db

load_dotenv()

# Gemini 2.5 models return 404 "no longer available to new users" for keys created after Sept 2026,
# so the 3.x models are used. Order = cheapest / highest free quota first; any error moves on to the next one.
# Optional: GEMINI_MODEL in .env (one name, or several separated by commas) is tried first.
_DEFAULT_GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3.5-flash"]
GEMINI_MODELS = []
for _m in [x.strip() for x in os.getenv("GEMINI_MODEL", "").split(",")] + _DEFAULT_GEMINI_MODELS:
    if _m and _m not in GEMINI_MODELS:
        GEMINI_MODELS.append(_m)
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
AI_TIMEOUT_SECONDS = 25
AI_CALLS_PER_MINUTE = 8          # per user - protects your free quota
FAQ_MIN_SCORE = 0.6              # 0..1, higher = stricter FAQ match
KNOWLEDGE_MIN_SCORE = 0.5

SYSTEM_PROMPT = (
    "You are StudentHub Assistant, the helper inside a college web application "
    "(used by {role}s). Reply briefly (max 5 sentences) in the same language the user writes in "
    "(English, Hindi or Hinglish). You do not have access to any student, faculty or fee records, "
    "so never invent personal data, marks, dates, fees or college rules. If the question is about "
    "specific college information you do not know, say you are not sure and suggest contacting the "
    "college office or admin. General study and education questions you may answer normally."
)

_STOPWORDS = {
    'the', 'a', 'an', 'is', 'are', 'am', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'me', 'my', 'i',
    'what', 'how', 'when', 'where', 'who', 'which', 'do', 'does', 'can', 'please', 'tell', 'about',
    'kya', 'hai', 'hain', 'ka', 'ki', 'ke', 'ko', 'me', 'mein', 'se', 'kaise', 'kab', 'kahan', 'kaun',
    'mujhe', 'muje', 'batao', 'bataiye', 'kar', 'karo', 'kare', 'hota', 'hoga', 'aur', 'ya', 'wala', 'wali',
}

# Rate limit tracking is backed by the chat_history table so it is shared across all workers and persists across restarts.


# ------------------------------------------------------------------
# Matching helpers
# ------------------------------------------------------------------
def _tokens(text):
    words = re.findall(r'\w+', (text or '').lower())
    return {w for w in words if w not in _STOPWORDS and len(w) > 1}


def _dice(a, b):
    if not a or not b:
        return 0.0
    return 2 * len(a & b) / (len(a) + len(b))


def find_faq_answer(cursor, message):
    """Best-matching FAQ answer from chatbot_faqs, or None if nothing is close enough."""
    msg_tokens = _tokens(message)
    if not msg_tokens:
        return None
    try:
        cursor.execute("SELECT question, answer FROM chatbot_faqs")
        rows = cursor.fetchall()
    except Exception as e:
        print("CHATBOT FAQ LOOKUP ERROR:", repr(e))
        return None

    msg_clean = re.sub(r'\W+', ' ', message.lower()).strip()
    best_score, best_answer = 0.0, None
    for r in rows:
        q_clean = re.sub(r'\W+', ' ', (r['question'] or '').lower()).strip()
        score = 1.0 if (q_clean and q_clean == msg_clean) else _dice(msg_tokens, _tokens(r['question']))
        if score > best_score:
            best_score, best_answer = score, r['answer']
    return best_answer if best_score >= FAQ_MIN_SCORE else None


def _knowledge_matches(cursor, message, limit=3):
    """Returns [(score, title, content)] from chatbot_knowledge, best first."""
    msg_tokens = _tokens(message)
    if not msg_tokens:
        return []
    try:
        cursor.execute("SELECT title, content FROM chatbot_knowledge")
        rows = cursor.fetchall()
    except Exception as e:
        print("CHATBOT KNOWLEDGE LOOKUP ERROR:", repr(e))
        return []
    scored = []
    for r in rows:
        title_score = _dice(msg_tokens, _tokens(r['title']))
        overlap = len(msg_tokens & _tokens((r['title'] or '') + ' ' + (r['content'] or '')))
        if title_score > 0 or overlap >= 2:
            scored.append((max(title_score, 0.01 * overlap), r['title'], r['content']))
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[:limit]


# ------------------------------------------------------------------
# AI providers (plain HTTPS calls)
# ------------------------------------------------------------------
def _post_json(url, headers, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'),
                                 headers={**headers, 'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=AI_TIMEOUT_SECONDS) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _gemini_text(data, model):
    """Plain text of the first candidate (thinking parts skipped), or None."""
    try:
        cand = data["candidates"][0]
        parts = (cand.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
        if not text:
            print(f"GEMINI EMPTY REPLY ({model}): finishReason={cand.get('finishReason')} promptFeedback={data.get('promptFeedback')}")
        return text or None
    except Exception as e:
        print(f"GEMINI BAD RESPONSE ({model}):", repr(e), str(data)[:300])
        return None


def _ask_gemini(system_prompt, user_text):
    key = (os.getenv("GEMINI_API_KEY") or "").strip()
    if not key:
        print("GEMINI: GEMINI_API_KEY is not set in Backend/.env")
        return None
    for model in GEMINI_MODELS:
        for thinking in (True, False):      # 2nd round = same model without the thinking setting
            gen_cfg = {"maxOutputTokens": 2048}
            if thinking:
                gen_cfg["thinkingConfig"] = {"thinkingLevel": "low"}   # quick answers; 'temperature' is deprecated, so not sent
            try:
                data = _post_json(
                    f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                    {"x-goog-api-key": key},
                    {
                        "systemInstruction": {"parts": [{"text": system_prompt}]},
                        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
                        "generationConfig": gen_cfg,
                    },
                )
                text = _gemini_text(data, model)
                if text:
                    return text
                break                       # empty / blocked reply -> next model
            except urllib.error.HTTPError as e:
                try:
                    body = e.read().decode("utf-8", "replace")[:300]
                except Exception:
                    body = ""
                print(f"GEMINI ERROR ({model}, thinking={thinking}): HTTP {e.code} {body}")
                if e.code == 400 and thinking:
                    continue                # this model may not accept thinkingLevel -> retry once without it
                break                       # 404 / 403 / 429 / 5xx -> next model
            except Exception as e:
                print(f"GEMINI ERROR ({model}):", repr(e))
                break
    return None


def _ask_openai(system_prompt, user_text):
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        return None
    try:
        data = _post_json(
            "https://api.openai.com/v1/chat/completions",
            {"Authorization": f"Bearer {key}"},
            {
                "model": OPENAI_MODEL,
                "messages": [{"role": "system", "content": system_prompt},
                             {"role": "user", "content": user_text}],
                "max_tokens": 500,
                "temperature": 0.4,
            },
        )
        return (data["choices"][0]["message"]["content"] or "").strip() or None
    except urllib.error.HTTPError as e:
        print("OPENAI ERROR: HTTP", e.code)
    except Exception as e:
        print("OPENAI ERROR:", repr(e))
    return None


def _rate_limited(user_id):
    """Enforces rate limiting using chat_history in DB so it works across multiple gunicorn workers and server restarts."""
    if not user_id:
        return False
    conn = None
    try:
        conn = get_db()
        cur = conn.cursor(dictionary=True)
        cur.execute(
            "SELECT COUNT(*) AS c FROM chat_history WHERE user_id = %s AND created_at >= NOW() - INTERVAL 1 MINUTE",
            (user_id,)
        )
        row = cur.fetchone()
        cur.close()
        return bool(row and row['c'] >= AI_CALLS_PER_MINUTE)
    except Exception as e:
        print("CHATBOT RATE LIMIT DB CHECK ERROR:", repr(e))
        return False
    finally:
        if conn and conn.is_connected():
            conn.close()


# ------------------------------------------------------------------
# Public helpers used by the *_routes.py files
# ------------------------------------------------------------------
def log_chat(user_id, message, reply):
    """Saves the exchange in chat_history. Uses its own connection so it never disturbs the caller's."""
    try:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("INSERT INTO chat_history (user_id, message, response) VALUES (%s, %s, %s)",
                    (user_id, (message or '')[:2000], (reply or '')[:4000]))
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        print("CHAT HISTORY SAVE ERROR:", repr(e))


def logged_assistant(view):
    """Put under @student_required / @faculty_required / @admin_required on an assistant route.
    Saves EVERY question + reply of the logged-in user in chat_history (FAQ, live data, knowledge base, AI)."""
    @wraps(view)
    def wrapper(*args, **kwargs):
        resp = view(*args, **kwargs)
        try:
            body = resp[0] if isinstance(resp, tuple) else resp
            reply = (body.get_json(silent=True) or {}).get('reply')
            message = ((request.get_json(silent=True) or {}).get('message') or '').strip()
            if message and reply:
                log_chat(request.user['user_id'], message, reply)
        except Exception as e:
            print("CHAT LOG ERROR:", repr(e))
        return resp
    return wrapper


def get_user_chat_history(user_id, limit=50):
    """The last `limit` exchanges of ONE user, oldest first (so they can be shown like a normal chat)."""
    conn = get_db()
    cur = conn.cursor(dictionary=True)
    try:
        cur.execute("SELECT message, response, created_at FROM chat_history "
                    "WHERE user_id = %s ORDER BY id DESC LIMIT %s", (user_id, limit))
        rows = cur.fetchall()
        rows.reverse()
        return rows
    finally:
        cur.close()
        conn.close()


def get_fallback_reply(cursor, message, user_id, role, help_text):
    """Called when the role's own keyword logic found nothing:
    knowledge table -> Gemini -> OpenAI -> help_text."""
    matches = _knowledge_matches(cursor, message)

    # Strong knowledge-base hit: answer straight from the database
    if matches and matches[0][0] >= KNOWLEDGE_MIN_SCORE:
        return matches[0][2]

    if _rate_limited(user_id):
        return "You're asking very fast 🙂 Please wait a minute and try again."

    system_prompt = SYSTEM_PROMPT.format(role=role)
    user_text = message
    if matches:   # weaker hits are given to the AI as background facts
        facts = "\n".join(f"- {t}: {c[:400]}" for _, t, c in matches)
        user_text = f"Background facts from the college database:\n{facts}\n\nUser question: {message}"

    reply = _ask_gemini(system_prompt, user_text) or _ask_openai(system_prompt, user_text)
    if reply:
        return reply

    if os.getenv("GEMINI_API_KEY") or os.getenv("OPENAI_API_KEY"):
        return "I can't answer that right now, please try again in a little while.\n\n" + help_text
    return help_text