# Agent Capabilities — Reference Brief

Design reference for Circe-Core: what leading model families do well, what
autonomous agents are expected to do, and where this repo stands against each
capability.

---

## 1. Model families

| Family | Signature strengths | Relevance to Circe-Core |
|---|---|---|
| OpenAI (GPT / ChatGPT) | All-around versatility; native computer & screen control; ecosystem (files, voice, image gen, web search) with multi-agent coordination. | The brain speaks the OpenAI-compatible chat-completions dialect, so any GPT-class endpoint can drive her. Computer control is out of scope for a stream companion. |
| Anthropic (Claude) | Deep reasoning and code quality; extended thinking; long-form technical writing; high-resolution vision. | Persona authoring and this runtime were written with Claude; a Claude endpoint can serve as the brain for higher-quality banter at higher latency. |
| Google (Gemini) | Native multimodality (video/audio/image over huge context); Workspace integration; Flash-tier speed/cost via distillation. | A Gemini Flash brain is the natural cost-efficient choice for always-on ambient chat; multimodal reaction to stream video is a future roadmap item. |
| xAI (Grok) | Real-time social pulse from X; multi-agent heavy reasoning. | The Twitch/YouTube adapters already provide the real-time pulse; X ingest is a possible additional adapter. |
| Open weights (DeepSeek, Kimi, Llama) | Cost-to-performance; full local control and privacy. | Default target: Ollama / KoboldCPP / LM Studio on the host, keeping latency and data local. |

## 2. Core capabilities of autonomous agents

- **Autonomous goal-seeking** — work toward an end objective, deciding
  sub-steps and escalating when stuck.
- **Memory architecture** — short-term working context (large token windows)
  layered with long-term episodic and graph-based memory.
- **Tool use & API action loops** — continuous observe → plan → act cycles
  against external code, files, databases, and software.
- **Multi-agent collaboration** — specialized agents (reflex, goal-based,
  utility-based, learning) coordinated hierarchically.
- **Decision intelligence & reflection** — evaluate trade-offs, inspect
  intermediate work, and self-refine before delivering.

## 3. Where Circe-Core stands

| Capability | Status | Implementation |
|---|---|---|
| Autonomous goal-seeking | Done | `src/goals.ts`: declarative goal queue with deterministic checks, multi-turn sub-step planning (`GoalStep`, `planGoal()`), prompt injection (`[done]`/`[active]`/`[pending]`), turn auto-advance, tool envelope control (`goal_status`/`goal_advance`), and `goal-active`/`goal-step`/`goal-done` events. |
| Short-term memory | Done | Rolling brain history (`src/brain.ts`), stream-context feed (`src/stream.ts`), conversation window per call. |
| Long-term episodic memory | Done (basic) | `src/memory.ts` — tagged facts with keyword/recency scoring, JSONL persistence, injected into every brain prompt. |
| Cross-session continuity | Done (basic) | `src/recap.ts` distills each session into recap-tagged facts (brain-assisted, deterministic fallback) on demand (`POST /recap`) or at shutdown (`recap.onStop`), so the next stream recalls "last time". |
| Graph/vector memory | Done (basic) | Tag co-occurrence graph (`src/graph.ts`): graph-assisted recall with `via` annotations, `memory_related` tool, `GET /memory?graph=1&tag=`. No embeddings needed. |
| Tool use / action loops | Done (basic) | Strict JSON envelope (`{ tool, args }`) with a validating `ToolRegistry` (`src/tools.ts`) and an observe-plan-act loop in `brain.askWithTools()` over context/mana/memory; `tool-call`/`tool-result`/`tool-error` events. |
| Multi-agent collaboration | Done (basic) | Writer + critic pair: a second `critic` brain performs the reflection critique pass through `brain.execute()`. Built-in persona variants (Circe / Evil Neuro) landed via `src/persona.ts`; per-viewer personas wired through runtime and viewer registry; two-hander duets (`src/duet.ts`, `POST /duet`) put two personas on one stream with separate prompts and a shared attributed transcript. |
| Viewer relationships & reputation | Done | `src/viewers.ts`: tracks chatter profiles across turns and sessions (`newcomer` -> `regular` -> `vip` / `heckler`), affinity (-100 to +100), observation notes, per-viewer persona overrides, tool envelope (`viewer_profile`, `viewer_note`, `viewer_affinity`), REST API (`GET /viewers`, `POST /viewers/:user`), JSONL persistence, and live dashboard card. |
| Decision intelligence & reflection | Done (basic) | Opt-in two-pass brain (`reflect: true`): draft → inner-critic rewrite → final; critique failure falls back to the draft; `brain-reflect` events expose the pair. |
| Low-latency spoken replies | Done (basic) | SSE token streaming (`brain.streamReply()`) into per-sentence TTS via `src/streamspeak.ts`; first sentence speaks mid-generation; `stream-start`/`stream-end` events. |
| Real-time information pulse | Partial | Twitch IRC + YouTube live chat + Bluesky Jetstream adapters; no X ingest (paid API tiers). |
| Multimodal perception | Done (basic) | `src/vision.ts` grabs stream frames (ffmpeg) and attaches them to brain turns as `image_url` parts; live at `GET /vision` and on the dashboard. No audio/video understanding beyond single frames. |
| Emotional state | Done (basic) | `src/emotion.ts` `EmotionTracker` folds cues/replies into a mood + intensity state, rendered into the brain prompt as an `[EMOTION]` block. |
| Spoken input (VAD + STT) | Done (basic) | `src/voice.ts` listen loop: ffmpeg mic chunk capture → zero-dependency WAV VAD (`src/vad.ts`) → STT bridge (`src/stt.ts`, OpenAI-compatible transcription endpoint or a local binary); spoken turns emit `voice-turn` events that enter the stream context as the speaker. |
| Real-time voice chat | Done (basic) | `src/voicechat.ts` consumes `voice-turn` events and speaks replies back through the reply pipeline (cues → TTS), with per-user ignore, a queue, and a `minGapMs` reply gap; status at `GET /voicechat`. |
| Talker + gamer tandem | Done (basic) | `src/gamer.ts` runs a separate gameplay policy over the live game state: pluggable deterministic policy or a strict-JSON brain policy, action allowlist, bounded history, dry-run-by-default delivery seam (`act`/`live`), `game-action`/`game-commentary` events, `[GAMEPLAY]` block in the talker prompt, and `POST /game/step`. |

## 4. Near-term design consequences

1. **Memory first** — episodic memory is the cheapest capability that makes
   her feel persistent. It needs no extra model, works offline, and improves
   every other loop (autopilot, chat, lore callbacks).
2. **Reflection done** — the two-pass brain (`draft → critique → final`) is in
   `src/brain.ts`, opt-in per session or per call.
3. **Tool use done** — the strict JSON envelope (`src/tools.ts`) plus the
   observe-plan-act loop in `brain.askWithTools()` let local models query
   context/mana/memory before answering.
4. **Streaming done** — SSE token streaming (`brain.streamReply()`) feeds an
   incremental sentence splitter (`src/streamspeak.ts`) so TTS starts
   mid-reply.
5. **Graph memory done** — the tag co-occurrence graph (`src/graph.ts`) gives
   recall a second, embedding-free signal; multimodal frame sampling
   (`src/vision.ts`) is in as well.
6. **Agents, ingest, and goals done** — writer + critic pair (`critic` brain),
   Bluesky Jetstream ingest (`src/bluesky.ts`), declarative goal pursuit and
   multi-turn sub-step planning (`src/goals.ts`). X ingest remains blocked on
   paid API tiers.
7. **Persona, emotion, and viewers done** — built-in persona variants (`src/persona.ts`,
   `CIRCE_PERSONA=evil-neuro` for Evil Neuro), per-call persona overrides and
   per-viewer relationship profiles with affinity, notes, and tiers (`src/viewers.ts`),
   and cue-driven emotional state (`src/emotion.ts`, `[EMOTION]` brain block) are in.
8. **Planning and continuity done** — session recaps into episodic memory
   (`src/recap.ts`) and multi-turn goal arcs with sub-step progression
   (`src/goals.ts`, `POST /goals/advance`, and tool belt integration).
9. **Voice input done** — VAD-gated mic loop (`src/voice.ts`) with a
   zero-dependency WAV VAD (`src/vad.ts`) and an STT bridge (`src/stt.ts`);
   spoken turns enter the stream context as `voice-turn` events, so she can
   hear Master as well as read chat.
10. **Split mind done** — the talker + gamer tandem (`src/gamer.ts`) separates
    play from conversation: a gameplay policy picks one input per tick against
    the live state, the actions and in-character reasoning land in the prompt
    as `[GAMEPLAY]`, and delivery to the game is an injectable seam that stays
    a dry run unless explicitly live. The remaining gap versus Neuro-sama is
    the game-specific controller itself, not the cognition loop.
11. **Two-hander done** — `src/duet.ts` runs Circe and a partner persona as
    distinct speakers over a shared attributed transcript, with each line
    generated from its own system prompt and spoken through the normal reply
    pipeline. This is the honest multi-persona setup: shared scene, separate
    voices, and no history contamination of the talker brain.
12. **Voice chat mode done** — spoken turns now produce spoken replies through
    the reply pipeline; the loop is paced by a gap window and queues
    interruptions instead of dropping them, closing the mic → STT → brain →
    TTS loop for continuous conversation.
