# Circe-Core Android (v0.1.0)

Expo + React Native companion app with two modes:

- **Remote** – connects to the Circe runtime on your PC over LAN. Start the runtime with
  `CIRCE_HOST=0.0.0.0` (optional `CIRCE_PORT`, default 8788) and enter `PC-IP:8788` in Settings.
  Uses `GET /events` (SSE live feed), `GET /mana` (mana meter), `POST /ask` (Circe answers through
  her full reply pipeline), `POST /chat` (viewer-style chat), and `POST /cue` (fire an expression).
- **Standalone** – Circe runs on the phone with the bundled `SYSTEM_PROMPT.md` persona against any
  OpenAI-compatible endpoint (presets: PC Ollama over LAN, OpenRouter, OpenAI, Groq). Streaming replies,
  on-device chat history, `/remember …` memory notes, Android TTS, and `*marker*` cues shown as mood chips.

API keys are stored in `expo-secure-store` only. Cleartext HTTP is allowed for LAN hosts.

Build: push a tag `circe-android-v*` (or run the workflow manually) — see `.github/workflows/android.yml`.
The APK is signed with `keystore/debug.p12` (password `android`, alias `androiddebugkey`) so later builds
install over earlier ones. It is a debug-grade key: fine for sideloading, not for a store.
