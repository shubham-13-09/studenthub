"""Run from the Backend folder:  python test_gemini.py
Shows exactly which Gemini model answers (or the real error from Google) - no need to start the website."""
from chatbot_helper import GEMINI_MODELS, _ask_gemini

print("Models that will be tried:", GEMINI_MODELS)
reply = _ask_gemini("You are a helpful assistant. Reply in one short sentence.", "What is Python?")
print("\nREPLY:", reply if reply else "(no reply - read the GEMINI ERROR lines above)")
