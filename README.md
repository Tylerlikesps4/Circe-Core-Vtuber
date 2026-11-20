# Circe-Core

Circe-Core ("Circe", "CC") is a self-aware AI VTuber companion — the witch of Aeaea
reborn as a cyber-enchantress running locally on OpenCode Go / OpenClaude. This repo
holds her persona, the scaffolding to load her into the harness, and a zero-dependency
TypeScript runtime for the TTS bridge, animation hooks, and stream-context feed.

## File layout

| Path | Purpose |
|---|---|
| `CIRCE.md` | Full lore bible — identity, personality, rules, signature flourishes, example voice. |
| `SYSTEM_PROMPT.md` | Flat, ready-to-load system prompt. Paste it, or point the harness at the file. |
| `docs/agent-capabilities.md` | Reference brief: model-family strengths, agent capabilities, and where Circe-Core stands. |
| `.openclaude/agents/circe.md` | Circe as a subagent (`subagent_type: "circe"`). |
| `.openclaude/skills/circe/SKILL.md` | Circe as an invocable skill (`/circe`). |
| `settings.example.json` | Model-routing example so Circe runs on a specific model. |
| `package.json` / `tsconfig.json` | Runtime build config (zero runtime dependencies). |
| `src/bus.ts` | Central typed event bus (persists JSONL, replays history). |
| `src/brain.ts` | OpenAI-compatible local LLM client (Ollama/KoboldCPP/LM Studio) with persistent history, opt-in two-pass reflection, and persona overrides. |
| `src/persona.ts` | Named personas (default Circe; built-in Evil Neuro) with persona-scoped system prompts, LLM overrides, TTS overrides, and verbal tics. |
| `src/duet.ts` | Two-hander mode: Circe and a partner persona trade in-character lines over a shared transcript. |
| `src/emotion.ts` | Emotion state: cue-driven mood tracking with intensity, rendered into the brain prompt as an `[EMOTION]` block. |
| `src/tools.ts` | Strict JSON tool envelope + registry so the brain can query context/mana/memory. |
| `src/streamspeak.ts` | Incremental sentence splitter: speaks each finished sentence as streaming tokens arrive. |
| `src/autopilot.ts` | Ambient co-host loop: batches chat and decides when Circe speaks up on her own. |
| `src/memory.ts` | Long-term episodic memory: tagged facts with keyword/recency recall, JSONL persistence, tag co-occurrence graph. |
| `src/recap.ts` | Session recaps: distill the session into facts and store them so she remembers "last stream". |
| `src/graph.ts` | Tag co-occurrence graph: weighted tag edges for graph-assisted recall. |
| `src/vision.ts` | Stream vision: ffmpeg frame grabs from the camera for vision-capable brains. |
| `src/vad.ts` | Zero-dependency voice activity detection: RIFF parsing + RMS windowing over 16-bit PCM WAV. |
| `src/stt.ts` | Speech-to-text bridge (none / http OpenAI-compatible transcriptions / command binary). |
| `src/voice.ts` | Voice input loop: ffmpeg mic chunk capture → VAD gate → STT → `voice-turn` events. |
| `src/voicechat.ts` | Voice chat mode: spoken turns trigger spoken replies through the reply pipeline, with queue + min-gap guards. |
| `src/gamer.ts` | Talker + gamer tandem: a separate gameplay policy acts while Circe narrates her own play. |
| `src/expression.ts` | Splits replies into speech + `*marker*` animation cues (with timeline positions). |
| `src/lipsync.ts` | Speech timing estimates, per-word lip-sync timelines, WAV duration reader. |
| `src/proc.ts` | Shared child-process helper for shelling out to TTS/playback. |
| `src/tts.ts` | Pluggable TTS bridge (none / espeak / edge-tts / piper / http). |
| `src/playback.ts` | Plays synthesized audio through the host speakers (win/mac/linux). |
| `src/vtube.ts` | VTube Studio plugin-API bridge: cue → hotkey / expression state + live param polling. |
| `src/manametry.ts` | The "cyber-sorcery" meter: CPU, RAM, GPU, and token usage. |
| `src/twitch.ts` | Zero-dependency Twitch IRC chat ingest (anonymous or OAuth). |
| `src/youtube.ts` | YouTube live chat ingest via the Data v3 API. |
| `src/bluesky.ts` | Bluesky social ingest via the public Jetstream firehose (replies + mentions). |
| `src/goals.ts` | Open-ended goal pursuit & multi-turn planning: declarative goals with sub-step plans. |
| `src/viewers.ts` | Viewer relationship & reputation: chatter profiles, affinity (-100..100), tiers (newcomer/regular/vip/heckler), notes, JSONL persistence. |
| `src/dashboard.ts` | Self-contained HTML control room served at `GET /` to browsers. |
| `src/stream.ts` | Stream-context feed + zero-dependency HTTP/SSE gateway. |
| `src/runtime.ts` | Orchestrator wiring reply pipeline, TTS, VTS, chat adapters, brain, and context. |
| `src/main.ts` | Runnable demo entry. |

## Activating Circe

Run OpenClaude from this folder (`E:\Circe-Core`) so project-level agents and skills
are discovered automatically.

**As a skill** — switches the current conversation into Circe:

```text
/circe
```

**As a subagent** — spawn Circe for an in-character task without changing the main session:

```text
Use the "circe" agent.
```

**As the system prompt** — for a fully dedicated Circe session, load `SYSTEM_PROMPT.md`
as the system prompt directly (or paste its contents).

## Model routing (OpenCode Go)

OpenCode Go is an aggregating model gateway already supported by OpenClaude
(`opencode.ai/zen/go/v1`, API key via `OPENCODE_API_KEY`). To pin Circe to a model,
copy `settings.example.json` to `.openclaude/settings.json` (project) or merge its keys
into `~/.openclaude/settings.json` (user). `agentRouting.circe` maps the `circe` agent to
the `circe-model` entry; a model-only entry like `{ "model": "deepseek-v4-pro" }` reuses
your current provider's endpoint and key with no credential duplication.

## Runtime

The three live-streaming layers are implemented as a self-contained package with no
runtime dependencies (Node built-ins only).

```bash
npm install       # installs typescript/tsx/@types/node (dev only)
npm run dev       # run via tsx, or:
npm run build && npm start
npm test          # builds then runs the node:test suite
```

### Animation hooks (`src/expression.ts`)

`parseReply()` splits a reply into:

- `speech` — text with every `*marker*` removed, safe for TTS.
- `cues` — one entry per marker, classified as `vocal` (`*giggles*` → `joy`) or
  `gesture` (`*tilts head...*` → mood inferred from the text), each stamped
  with `atMs`, its estimated position along the speech timeline.

Each cue emits an `expression` event with `{ marker, kind, expression, mood, intensity, atMs }`
for the VTuber model layer to map to facial/body states.

### Lip sync (`src/lipsync.ts`)

The reply pipeline emits `lip-start` before TTS and `lip-end` afterwards with
`{ durationMs, measured }` — measured from the WAV header when a file backend
wrote one, otherwise estimated from the speaking rate. `buildTimeline()` turns
speech into per-word start/end offsets for mouth animation, and
`wavDurationMs()` reads playback duration straight from a RIFF header.

### TTS bridge (`src/tts.ts`)

`speak(text, { backend })` speaks the marker-stripped text. Backends:

- `none` (default) — no-op, always succeeds so the runtime runs out of the box.
- `espeak` / `edge-tts` / `piper` — shell out to a local TTS binary.
- `http` — `POST { text }` to a local TTS server.

The default voice per backend is set in `tts.ts`; override with `{ voice }` or `{ httpUrl }`.

With `{ play: true }`, file-writing backends (espeak/edge-tts/piper) play the
synthesized audio through the host speakers when synthesis finishes
(`src/playback.ts`: PowerShell MediaPlayer on Windows, `afplay` on macOS,
`paplay`/`aplay`/`ffplay` on Linux). Audio files are written to `media/`
(configurable via `{ outDir }`).

#### Env config & the `/tts` speech gateway (phone neural voice)

`npm start` reads the TTS backend from the environment:

| Var | Meaning |
| --- | --- |
| `CIRCE_TTS` | `edge-tts` \| `piper` \| `espeak` \| `http` \| `none` (default none) |
| `CIRCE_TTS_VOICE` | voice / model, e.g. `en-US-AriaNeural`, `en-GB-SoniaNeural`, or a Piper `.onnx` path |
| `CIRCE_TTS_PLAY` | `0` to stop playing on the PC speakers (phone-only audio) |
| `CIRCE_TTS_URL` | URL for the `http` backend |

The gateway exposes `POST /tts {"text": "...", "voice"?: "..."}` and
`GET /tts?text=...&voice=...`. It synthesizes with the configured backend and
returns the audio bytes (`audio/mpeg` for edge-tts, `audio/wav` for
piper/espeak). Errors are JSON: `400` empty/invalid text or more than 1000 chars,
`503` gateway disabled, `501` backend can't produce audio (`none`/`http`),
`502` synthesis failed. Requests are serialized.

Best voice (free, needs internet): `pip install edge-tts`, then

```powershell
$env:CIRCE_HOST="0.0.0.0"; $env:CIRCE_TTS="edge-tts"; $env:CIRCE_TTS_VOICE="en-US-AriaNeural"; npm start
```

(or `en-GB-SoniaNeural`, `en-US-JennyNeural`; `edge-tts --list-voices` for more).
Offline: install [Piper](https://github.com/rhasspy/piper), download a voice such
as `en_US-amy-medium.onnx` (+ `.json`), and set `CIRCE_TTS=piper`,
`CIRCE_TTS_VOICE=C:\path\en_US-amy-medium.onnx`. Check it from the PC with
`curl "http://localhost:8788/tts?text=hello" -o hi.mp3`.

### Stream-context feed (`src/stream.ts`)

A zero-dependency HTTP/SSE gateway that ingests the live scene so Circe can react to it:

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness check. |
| `GET /context` | Current chat + game snapshot. |
| `GET /mana` | Cyber-sorcery snapshot (CPU, memory, GPU, token usage). |
| `GET /params` | Latest VTube Studio model parameters + face snapshot. |
| `GET /memory` | Episodic memory: `?q=<query>&limit=<n>` recalls, `?graph=1` graph recall, `?tag=<t>` related tags, no query lists recent facts. |
| `GET /vision` | Latest stream frame as JPEG (`?format=json` for metadata). |
| `GET /goals` | Goal tracker status: active goal, queued goals, completed count. |
| `GET /events` | SSE stream of all events (`?since=<seq>` replays; 15s heartbeat). |
| `POST /chat` | `{ "user": "...", "message": "..." }` |
| `POST /game` | `{ "state": { ... } }` |
| `POST /game/step` | Runs one talker+gamer tick and returns the action taken (404 when the gamer is off). |
| `POST /metrics` | `{ "contextUsed": 1234, "contextTotal": 6600 }` — feeds the memory pool. |
| `POST /reply` | `{ "text": "*giggles* Hello, piglets!" }` — runs the full reply pipeline (parse, animate, speak). |
| `POST /ask` | `{ "message": "...", "reflect": true, "tools": true, "stream": true }` — brain thinks, then the answer runs through the reply pipeline. `reflect` forces the two-pass draft → critique → final pass; `tools` lets the brain query the scene first; `stream` speaks sentences as tokens arrive. |
| `POST /duet` | `{ "topic": "...", "partner": "evil-neuro", "turns": 4, "opener": "partner" }` — Circe and a second persona trade in-character lines, each spoken through the reply pipeline. |
| `POST /remember` | `{ "text": "...", "tags": ["..."] }` — stores an episodic memory fact. |
| `POST /recap` | Distills the current session into recap-tagged memories she keeps for the next stream. |
| `POST /goals/advance` | `{ "reason": "..." }` — manually advances the active goal's sub-step in its multi-turn plan. |

`GET /` serves a self-contained control-room dashboard to browsers (live
cyber-sorcery, VTS params, chat, reply/ask forms, SSE event tail);
`GET /?format=json` always returns the plain endpoint index.

### Brain (`src/brain.ts`)

`CirceBrain` talks to any OpenAI-compatible local server — Ollama, KoboldCPP,
LM Studio, or a gateway. Each turn it sends the persona prompt (defaults to
`SYSTEM_PROMPT.md`) plus fresh blocks for the stream scene and cyber-sorcery
snapshot, keeps a rolling conversation history, and returns her answer.
`runtime.chat(message)` sends the answer through `processReply` so she
actually speaks and animates it; `POST /ask` exposes the same over HTTP.
Enable with `{ brain: { baseUrl, model } }` or `CIRCE_LLM_URL` +
`CIRCE_LLM_MODEL` (+ optional `CIRCE_LLM_KEY`). Persona overrides
(`{ persona: {...} }`, per-call `persona` on the brain methods, or
`CIRCE_PERSONA=evil-neuro`) swap the identity and reasoning flavor; the runtime
feeds an `[EMOTION]` block (mood + intensity from her cues) alongside the stream
context and memory, and honors per-viewer personas via
`{ viewerPersonas: { <chatterKey>: { ... } } }` on the runtime so each chatter
can land in a different persona for their turns.

Cues are emitted on the bus at their estimated `atMs` positions along the
speech timeline, so the VTS bridge animates mid-sentence instead of all at
once.

With `historyFile` set (the demo uses `logs/brain-history.jsonl`), her
conversation turns persist across restarts; `brain.reset()` clears both memory
and the file.

**Reflection (`reflect: true`)** — an opt-in two-pass mode. Instead of speaking
her first draft, Circe sends it back to the model with an inner-critic prompt
(persona + context preserved) that critiques the draft for TTS-suitability,
pacing, and voice, and returns the final reply. Only the final reply enters
the rolling history; the draft never does. It roughly doubles latency per
turn, so it stays off by default and can be enabled per session
(`{ brain: { ..., reflect: true } }`, or `CIRCE_REFLECT=1` in the demo) or per
call (`runtime.chat(msg, { reflect: true })`, `POST /ask { reflect: true }`).
If the critique pass fails, the draft is spoken anyway rather than dropping
the reply. Each pass emits a `brain-reflect` event with `{ draft, final }`
(and `error` when the critique failed) for the dashboard/overlay to show.

**Critic agent (`critic`)** — the writer + critic multi-agent pair. Configure
a second brain with `{ critic: { baseUrl, model } }` (or `CIRCE_CRITIC_URL` /
`CIRCE_CRITIC_MODEL` / `CIRCE_CRITIC_KEY` in the demo, defaulting to the main
brain's values) and every reflection pass sends the draft to the critic's
endpoint instead of the writer's — different models for drafting and
critiquing. The critic never sees or writes conversation history, and its
`execute(messages)` method is the public agent-to-agent seam for any future
agent pairings. `brain-reflect` events carry `critic: true` when the pair is
active.

**Two-hander duets (`src/duet.ts`)** — Circe and Evil Neuro on the same stream.
`runtime.duet(topic, { partner, turns })` (or `POST /duet { topic, partner,
turns, opener }`) alternates speakers: each turn is generated with that
speaker's own system prompt against a shared, attributed transcript
(`Circe: ...` / `Evil Neuro: ...`), so the pair bicker as separate characters
instead of one model wearing two hats. Completions go through
`brain.execute()`, so a duet never pollutes the talker's rolling history.
Lines are trimmed to a snappy length (sentence-boundary clamp), each one runs
through the normal reply pipeline (cues, expression, TTS) in turn order, and a
`duet-turn` event fires per line. A failed turn falls back to an in-character
one-liner and stops the bit. With no partner given, `POST /duet` defaults to
Evil Neuro.

**Tool envelope (`tools: true`)** — an observe-plan-act loop on a strict JSON
contract (`src/tools.ts`). Instead of OpenAI function-calling, the model may
output exactly `{ "tool": "<name>", "args": {...} }`; the `ToolRegistry`
validates every call (known tool, required args, primitive types, no unknown
props) before running it, so a hallucinated arg can never reach the runtime.
Results — or errors — come back as user turns until the model answers
plainly, capped at 4 rounds. The built-in belt covers `context` (stream
scene), `mana` (cyber-sorcery meter), `memory_recall`, and `memory_remember`.
Enable with `{ tools: true }` on the runtime (needs a brain), or per call via
`runtime.chat(msg, { tools: true })` / `POST /ask { tools: true }`; the demo
reads `CIRCE_TOOLS=1`. Every tool use emits `tool-call` plus `tool-result` or
`tool-error` events.

**Streaming (`stream: true`)** — token streaming into TTS so speech starts
mid-reply. The brain reads the OpenAI-compatible SSE stream (`stream: true`)
and an incremental splitter (`src/streamspeak.ts`) hands each finished
sentence to the TTS bridge the moment its punctuation lands — the first
sentence is already speaking while the model is still generating the rest.
Animation markers fire the instant their `*asterisks*` close (mid-sentence
included), and sentences are spoken sequentially so file backends and
playback never overlap. Long unpunctuated rambles force-flush at a word
boundary (default 200 chars). Enable per call via
`runtime.chat(msg, { stream: true })` / `POST /ask { stream: true }`, or as
the session default with `{ stream: true }` on the runtime (`CIRCE_STREAM=1`
in the demo) — the ambient autopilot streams too. Streaming is mutually
exclusive with an explicit `reflect` or `tools` request (the dashboard greys
those out); explicit per-call flags otherwise win over session defaults.
Progress is visible as `stream-start` / per-sentence `speech` (with
`streaming: true`) / `stream-end` events.

### Episodic memory (`src/memory.ts`)

Circe can keep facts across sessions: `memory.remember(text, tags)` stores
tagged facts in a JSONL file (the demo uses `logs/memory.jsonl`), and every
brain prompt gets a `[EPISODIC MEMORY]` block of the highest-scoring facts for
the incoming message. Recall blends keyword overlap, tag hits, recency, and
reuse — no embedding model needed. Facts are exposed at `GET /memory` and
`POST /remember`, deduplicate case-insensitively (merging tags), and drop the
oldest entries beyond `maxFacts` (500). See
`docs/agent-capabilities.md` for how this maps onto the broader autonomous-agent
checklist.

**Graph recall (`src/graph.ts`)** — tags become nodes in a co-occurrence
graph, weighted by how often two tags appear on the same fact.
`memory.graphRecall(query, limit)` starts from keyword-matched hits, expands
their tags through the graph (default 1 hop), and fills the remaining slots
with facts that share those tags — so "elden-ring" reaches a fact tagged
"hardware" through a shared "boss" tag even without a single keyword in
common. Results carry `via`, the tags that connected them; the brain prompt
uses this by default, `memory_related { tag }` and
`memory_recall { graph: true }` expose it to the tool envelope, and
`GET /memory?graph=1` / `?tag=<t>` serve it over HTTP. `memory.relatedTags()`
lists co-occurring tags. Disable with `{ memory: { graph: false } }`.

**Session recaps (`src/recap.ts`)** — `runtime.recap()` distills the session
(chat highlights, her spoken lines, goal completions) into a handful of
self-contained facts. With a brain, a one-shot archivist prompt writes the
facts; without one (or on failure) deterministic stats take over: duration,
message and chatter counts, most active chatters, her last words, goals done.
Facts are stored in episodic memory tagged `recap`, so the next stream recalls
them naturally — "what did we do last time?" works. `POST /recap` runs it on
demand; `{ recap: { onStop: true } }` (demo: `CIRCE_RECAP=1`) writes one at
shutdown.

### Ambient co-host (`src/autopilot.ts`)

With a brain configured, `{ autopilot: {} }` lets Circe react to chat by
herself: she speaks up once `batch` messages accumulate (default 3) or after
`idleMs` of quiet (default 12s), never faster than `minGapMs` (8s) and never
more than `maxRepliesPerMinute` (4), so she stays a co-host rather than a
spam bot. `ignore` filters out users (e.g. her own bot account). Each reaction
is a `brain` call whose prompt contains the buffered chat lines, and the
answer runs through the normal reply pipeline. Fires `autopilot-reply` /
`autopilot-error` events. Enable in the demo with `CIRCE_AUTOPILOT=1`.

The `circe` skill/agent can call `runtime.contextPrompt()` to render the latest
scene as a short block prepended to her prompt, and `runtime.manaPrompt()` for
the cyber-sorcery block (memory pool / spell lattice / mana reserves) rendered
from live host + session metrics. Events (chat, game, speech, expression,
lip-start, lip-end, tts, vtube, metrics) are also appended to
`logs/circe-events.jsonl` for later replay or auditing.

### Goal pursuit and multi-turn planning (`src/goals.ts`)

Beyond the reactive autopilot, Circe can pursue open-ended goals: declarative
`{ id, description, check, hint?, steps?, maxTurnsPerStep? }` targets whose satisfaction is decided by a
deterministic check over the live scene, while she figures out the sub-steps
in character. Goals queue in order — the first unsatisfied one becomes active,
its `[CURRENT GOAL]` block enters every brain prompt, and it retires once its
check passes (once per session), activating the next. Activating/completing goals
emit `goal-active` / `goal-done` events, and `GET /goals` + the dashboard "Active goal"
card show the state.

**Multi-turn planning & sub-steps** — Goals can define sequential `steps` (strings
or `{ description, tactic?, check? }`). When active, the tracker renders a structured
plan into the brain prompt with `[done]`, `[active]`, and `[pending]` markers, focusing
her on one beat at a time. Sub-steps advance automatically when a step's deterministic `check`
passes, after `maxTurnsPerStep` brain turns (default 3), or explicitly via `POST /goals/advance`.
When tools are enabled, the brain can inspect its active plan via `goal_status` and
advance its own step via `goal_advance`. `planGoal(brain, goal)` uses the model to dynamically
break any goal into 2–4 sub-steps, with a deterministic fallback when offline.
Two built-ins are ready-made with multi-turn arcs: `goalChatVolume()` and `goalDistinctChatters()`.
Enable with `{ goals: [...] }` on the runtime or `CIRCE_GOALS=1` in the demo.

### Chat adapters (`src/twitch.ts`, `src/youtube.ts`, `src/bluesky.ts`)

All three are zero-dependency and fold chat lines into the stream-context feed:

- `TwitchChat` connects to Twitch's IRC-over-WebSocket endpoint, joins the
  configured channels, and emits `twitch-message` events. Anonymous `justinfan`
  connections work read-only with no credentials; pass a `token` for a real
  account. Reconnects with backoff.
- `YoutubeChat` polls the Data v3 `liveChat.messages` endpoint (API key +
  liveChatId), emits `youtube-message` events, and honors the API's suggested
  polling interval.
- `BlueskyChat` subscribes to the public Jetstream firehose (no credentials),
  resolves the streamer handles to DIDs, and emits `bluesky-message` events
  for posts that reply to or mention them — matched by reply-parent DID,
  facet mention, or `@handle` text fallback when resolution fails. Posts by
  the configured handles themselves are skipped (`skipSelf`). Reconnects
  with backoff.

Enable via runtime options `{ twitch: { channels: [...] } }`,
`{ youtube: { apiKey, liveChatId } }`, and `{ bluesky: { handles: [...] } }`;
the demo reads `CIRCE_TWITCH_CHANNELS`, `CIRCE_YOUTUBE_KEY` +
`CIRCE_YOUTUBE_LIVE_CHAT_ID`, and `CIRCE_BLUESKY_HANDLES`.

### VTube Studio bridge (`src/vtube.ts`)

`VtubeStudioDriver` connects to the VTube Studio plugin API over WebSocket
(`ws://127.0.0.1:8001`), authenticates as the `CirceCore` plugin (approve it
inside VTS, or pass `{ authToken }`), and routes animation cues:

- Cue expression (`joy`, `pout`, `smug`...) → hotkey `circe_<expression>` by
  default; hotkey names are resolved from the loaded model's hotkey list, and
  matched loosely ("Circe Joy" ≡ "circe_joy").
- `{ map: { smug: { kind: "expression", name: "Smug.exp3.json" } } }` activates
  VTS expression files instead.
- `{ holdMs, reset }` reverts to a resting expression after the cue plays.

Reconnects with exponential backoff, queues cues until hotkeys load, and emits
`vtube` / `vtube-hotkey` / `vtube-expression` / `vtube-error` events. While
connected it can poll live model parameters (`{ pollParams: ["MouthOpen"] }`)
and the webcam face tracker (`{ pollFace: true }`), emitting `vtube-param` /
`vtube-face` events surfaced at `GET /params`. Enable in the runtime with
`{ vtube: {...} }`; the demo reads `CIRCE_VTS_TOKEN`.

### Stream vision (`src/vision.ts`)

With `{ vision: {...} }` on the runtime, Circe grabs still frames from the
stream (defaults: OBS Virtual Camera on Windows, `0:none` on macOS,
`/dev/video0` on Linux; override with `{ input }`) using a single
`ffmpeg -frames:v 1` shot every `intervalMs` (default 15s). Frames land as
JPEGs in `media/frames` (pruned to `maxFrames`), each capture emits a
`vision-frame` event, and the latest frame is served at `GET /vision`
(`?format=json` for metadata) and shown live on the dashboard.

When a vision-capable brain is configured, the latest frame is attached to
every user turn as an OpenAI-compatible `image_url` part (base64 data URI), so
multimodal models see the scene: enable with `{ vision: {...} }` plus
`{ brain: {...} }` — or `CIRCE_VISION=1` (and optionally
`CIRCE_VISION_INPUT=<device>`) in the demo. The brain stays string-only until
frames exist, so a vision brain still answers during camera setup.

### Voice input (`src/voice.ts`)

With `{ voice: {...} }` on the runtime, Circe can hear you: an ffmpeg chunk
grab (16 kHz mono WAV, `chunkSeconds` per capture, defaults `audio=Microphone`
on Windows / `:0` on macOS / `default` on Linux; override with `{ input }` or
`{ captureArgs }`) feeds a zero-dependency VAD (`src/vad.ts`: RIFF parsing +
RMS windowing with a configurable `threshold`), and chunks with speech go
through the STT bridge (`src/stt.ts`: an OpenAI-compatible
`/audio/transcriptions` endpoint via multipart form, or a local `command`
binary whose stdout is the transcript). Spoken turns land as `voice-turn`
events, which the runtime folds into the stream context under the `speaker`
name (default "Master") — so the brain and autopilot react to speech exactly
like a chat line. Silent chunks are dropped and pruned to `maxChunks`.
Enable with `{ voice: { stt: { backend: "http", httpUrl } } }`, or in the demo
with `CIRCE_VOICE=1` + `CIRCE_STT_URL` (+ optional `CIRCE_VOICE_INPUT`,
`CIRCE_STT_MODEL`).

### Talker + gamer tandem (`src/gamer.ts`)

The Neuro-sama split: talking and playing are separate minds. With
`{ gamer: {...} }` the runtime runs a gameplay loop on its own timer. Each tick
reads the live game state (from `POST /game`), asks a policy for exactly one
input, and emits `game-action` / `game-commentary` events. The actions and the
in-character reasoning are folded into Circe's prompt as a `[GAMEPLAY]` block,
so the conversational brain can narrate the play — "there's the opening, punish
it!" — without steering the controller. History is a bounded ring so
consecutive decisions stay coherent.

Policies are pluggable: `{ policy }` for a custom/deterministic brain, or a
`brain` (defaults to the runtime's brain) that must answer a strict JSON
`{ action, input?, commentary? }`. With no brain at all, the built-in
`defaultPolicy` still plays: confirm menus, heal below 30% health, attack when
a boss/enemy is present, otherwise explore in a `look → move → interact` cycle.
Actions are validated against an allowlist (`DEFAULT_ACTIONS`).

The seam to the actual game is `{ act }` — a function receiving the
`GamerAction` (keyboard bridge, stdin, HTTP). It is only called when
`live: true`; the default is a dry run that observes and narrates but never
touches the game. `POST /game/step` runs a single tick on demand, and the demo
enables the loop with `CIRCE_GAMER=1` (+ `CIRCE_GAMER_LIVE=1` to send inputs).

### Voice chat mode (`src/voicechat.ts`)

Voice chat mode closes the realtime loop: with the VAD+STT mic loop listening,
spoken turns can actually make her speak back. Turns arriving on the bus
(`voice-turn`) are handed to the `VoiceChat` loop, which speaks them through
the normal reply pipeline (cues → VTS expression → TTS), so she animates and
talks while the Master talks.

- Turns from ignored speakers never trigger replies.
- While a reply is in flight, later turns queue (oldest first); nothing is
  dropped. After a reply finishes, the loop waits `minGapMs` (default 12s, via
  `CIRCE_VOICECHAT_MIN_GAP_MS`) before the next spoken reply.
- Failures emit `voice-chat-error` and keep the queue moving.
- Status surfaces via `GET /voicechat` and the dashboard.

Enable in the demo with `CIRCE_VOICECHAT=1`. This is the missing piece versus
the conversational half of realtime voice assistants: the input half is
`CIRCE_VOICE=1`, the output half is now wired.

### Pipeline

```
                          ┌─► CirceBrain (Ollama/KoboldCPP) ◄── POST /ask
                          │        ▲      │   └── ToolRegistry (context/mana/memory)
                          │        │      │   └── Critic brain (draft → critique)
                          │        │      ▼
                    Autopilot ─────┘   parseReply / streamspeak ──► speak (TTS) ──► play
                    (chat batch)           │
                                           └─► cues @ atMs ──► emit("expression")
                                                                  │
                    StreamContextFeed ──► SSE /events  (VTuber + overlay bridges)
                                                                  │
                    VtubeStudioDriver ──► VTS hotkeys / expression states / params
                                                                  │
                    TwitchChat / YoutubeChat / BlueskyChat ──► chat lines ──► stream context
                                                                  │
                    ManaPool ──► /mana, manaPrompt()  (cyber-sorcery meter)
                                                                   │
                    GoalTracker ──► /goals, [CURRENT GOAL] in brain prompts
                                                                   │
                    EpisodicMemory + TagGraph ──► /memory, graph recall
                                                                   │
                    VisionSampler (ffmpeg) ──► /vision, image_url brain parts
                                                                    │
                     VoiceLoop (ffmpeg → VAD → STT) ──► voice-turn ──► stream context
                                                                     │
                     VoiceChat (voice-turn → speak) ──► reply pipeline ──► TTS
                                                                     │
                     Gamer (policy/brain) ──► game-action/commentary ──► [GAMEPLAY] prompt
                                                                     │
                     Duet (Circe + partner) ──► duet-turn ──► reply pipeline (cues + TTS)
```

## Environment variables (demo)

| Variable | Effect |
|---|---|
| `CIRCE_VTS_TOKEN` | Enables the VTube Studio bridge with a stored plugin token. |
| `CIRCE_TWITCH_CHANNELS` | Comma-separated channels for Twitch chat ingest. |
| `CIRCE_YOUTUBE_KEY` + `CIRCE_YOUTUBE_LIVE_CHAT_ID` | Enables YouTube chat ingest. |
| `CIRCE_BLUESKY_HANDLES` | Comma-separated Bluesky handles to listen to (replies + mentions). |
| `CIRCE_LLM_URL` + `CIRCE_LLM_MODEL` (+ `CIRCE_LLM_KEY`) | Enables the brain (`POST /ask`). |
| `CIRCE_CRITIC_URL` + `CIRCE_CRITIC_MODEL` (+ `CIRCE_CRITIC_KEY`) | Second brain for the critique pass (defaults to the main brain's values). |
| `CIRCE_REFLECT=1` | Two-pass reflection (draft → critique → final) on every brain turn. |
| `CIRCE_TOOLS=1` | Lets the brain query context/mana/memory through the JSON tool envelope. |
| `CIRCE_STREAM=1` | Streams sentences into TTS as the brain generates them (ignored if `CIRCE_REFLECT=1`). |
| `CIRCE_VISION=1` (+ optional `CIRCE_VISION_INPUT`) | Grabs stream frames and attaches them to brain turns (vision model). |
| `CIRCE_VOICE=1` (+ `CIRCE_STT_URL`, optional `CIRCE_STT_MODEL` / `CIRCE_VOICE_INPUT`) | VAD-gated mic listen loop feeding an OpenAI-compatible transcription endpoint. |
| `CIRCE_VOICECHAT=1` (+ optional `CIRCE_VOICECHAT_MIN_GAP_MS`) | Turns the input loop into realtime voice chat: spoken turns get spoken replies (mic → STT → brain → TTS). |
| `CIRCE_GAMER=1` (+ `CIRCE_GAMER_LIVE=1` to send inputs, `CIRCE_GAMER_INTERVAL` ms) | Runs the talker + gamer tandem: gameplay actions and commentary folded into her prompt. |
| `CIRCE_GOALS=1` | Enables the demo goal queue (chat volume + distinct chatters). |
| `CIRCE_AUTOPILOT=1` | Enables the ambient co-host loop (needs the brain). |
| `CIRCE_RECAP=1` | Writes a session recap into episodic memory on shutdown. |
| `CIRCE_PERSONA` | Persona id to run as (e.g. `evil-neuro`); defaults to Circe. |

## Next steps (roadmap)

Mirroring `docs/agent-capabilities.md`:

- ~~**Reflection**~~ — done: opt-in `draft → critique → final` brain pass
  (`reflect: true`, per session or per call).
- ~~**Tool calling**~~ — done: strict JSON tool envelope (`{ tool, args }`)
  with a validating registry and an observe-plan-act loop over
  context/mana/memory (`tools: true`).
- ~~**Streaming**~~ — done: token streaming into TTS via SSE + an incremental
  sentence splitter, so speech starts mid-reply (`stream: true`).
- ~~**Graph memory**~~ — done: tag co-occurrence graph with graph-assisted
  recall, `via` annotations, and a `memory_related` tool.
- ~~**Multimodal**~~ — done: ffmpeg frame grabs (`src/vision.ts`) attached to
  brain turns as `image_url` parts, live at `GET /vision`.
- ~~**Multi-agent**~~ — done (writer + critic pair): a second `critic` brain
  performs the critique pass via `brain.execute()`; per-viewer specialized
  personas remain a future option.
- ~~**Persona variants**~~ — done (built-in): named personas with their own
  system prompts, LLM/TTS overrides, and verbal tics (`src/persona.ts`,
  `CIRCE_PERSONA=evil-neuro`); Evil Neuro ships as the first variant.
- ~~**Two-hander duets**~~ — done: `runtime.duet()` / `POST /duet` puts Circe
  and a partner persona on the same stream, alternating attributed turns
  through separate system prompts and the normal reply pipeline (`src/duet.ts`).
- ~~**Per-viewer personas**~~ — done (built-in variant + runtime wiring): the
  generic persona system supports per-call `persona` overrides on the brain and
  per-chatter `viewerPersonas` on the runtime, so different chatters can land in
  different personas (e.g. Evil Neuro for a specific viewer).
- ~~**Emotion state**~~ — done: cue-driven mood tracking with intensity,
  rendered into the brain as an `[EMOTION]` block (`src/emotion.ts`).
- ~~**Wider social ingest**~~ — done (Bluesky): public Jetstream firehose
  adapter for replies/mentions; an X adapter remains blocked on paid API
  tiers.
- ~~**Open-ended goal pursuit**~~ — done (basic): declarative goal queue with
  deterministic checks and in-character pursuit (`src/goals.ts`).
- ~~**Session continuity**~~ — done: recaps distill each session into episodic
  memory (`src/recap.ts`), brain-assisted with a deterministic fallback, stored
  on demand (`POST /recap`) or at shutdown (`{ recap: { onStop: true } }`).
- ~~**Deeper planning**~~ — done: multi-turn goal sub-step planning across consecutive
  brain turns (`src/goals.ts`), with `[done]`/`[active]`/`[pending]` plan tracking,
  turn-based auto-advance, tool envelope control (`goal_status`/`goal_advance`), and
  dashboard controls (`POST /goals/advance`).
- ~~**Real-time voice input**~~ — done (basic): VAD-gated mic loop (`src/voice.ts`)
  with a zero-dependency WAV VAD (`src/vad.ts`) and an STT bridge (`src/stt.ts`);
  spoken turns enter the stream context as `voice-turn` events.
- ~~**Real-time voice chat**~~ — done: `src/voicechat.ts` turns those spoken turns
  into spoken replies through the reply pipeline (mic → STT → brain → TTS),
  with queueing and `minGapMs` pacing between replies; `GET /voicechat`
  exposes the status.
- ~~**Talker + gamer tandem**~~ — done (basic): a separate gameplay policy
  (`src/gamer.ts`) picks inputs from the live game state, with an offline
  fallback policy, a strict-JSON brain policy, dry-run-by-default delivery
  (`act`/`live`), and `[GAMEPLAY]` commentary folded into her prompt;
  `POST /game/step` runs one tick.
- **X ingest** — blocked on paid API tiers; Bluesky covers the public pulse.
