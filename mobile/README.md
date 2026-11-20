# Circe-Core Android (v0.2.0)

## v0.2.0 — voices

- **Settings → Voice**: pick any phone voice (English, HQ/network first), pitch
  and speed sliders, ▶ Test. A good English female Google voice is auto-picked
  on first launch when the phone has one.
- **PC neural voice** (works in Standalone and Remote): start the PC runtime with
  `CIRCE_HOST=0.0.0.0 CIRCE_TTS=edge-tts CIRCE_TTS_VOICE=en-US-AriaNeural`
  (see the root README "/tts speech gateway"), set **PC host:port**, turn on
  **PC neural voice**. Each finished sentence is fetched from `/tts` and played
  in order; if the PC is unreachable the phone voice is used (retried after 30s).
- **Remote → 🔈 on phone**: plays the runtime's speech on the phone (add
  `CIRCE_TTS_PLAY=0` on the PC if you don't want it on the PC speakers too).
- **OpenRouter preset**: quick-pick chips for free models (`:free`).


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
