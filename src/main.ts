import { CirceRuntime } from "./runtime.js";
import { goalChatVolume, goalDistinctChatters } from "./goals.js";
import { DEFAULT_PERSONA } from "./persona.js";

const vtubeToken = process.env.CIRCE_VTS_TOKEN;
const twitchChannels = (process.env.CIRCE_TWITCH_CHANNELS ?? "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
const blueskyHandles = (process.env.CIRCE_BLUESKY_HANDLES ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);
const youtubeKey = process.env.CIRCE_YOUTUBE_KEY;
const youtubeLiveChatId = process.env.CIRCE_YOUTUBE_LIVE_CHAT_ID;
const llmUrl = process.env.CIRCE_LLM_URL;
const llmModel = process.env.CIRCE_LLM_MODEL;
const llmKey = process.env.CIRCE_LLM_KEY;
const criticUrl = process.env.CIRCE_CRITIC_URL ?? llmUrl;
const criticModel = process.env.CIRCE_CRITIC_MODEL ?? llmModel;
const criticKey = process.env.CIRCE_CRITIC_KEY ?? llmKey;
const visionInput = process.env.CIRCE_VISION_INPUT;
const voiceInput = process.env.CIRCE_VOICE_INPUT;
const sttUrl = process.env.CIRCE_STT_URL;
const voiceChatMinGapMs = Math.max(0, Number(process.env.CIRCE_VOICECHAT_MIN_GAP_MS) || 12_000);
const personaId = process.env.CIRCE_PERSONA;

const runtime = new CirceRuntime({
  port: Number(process.env.CIRCE_PORT) || 8788,
  host: process.env.CIRCE_HOST || undefined,
  logFile: "logs/circe-events.jsonl",
  persona: personaId ?? undefined,
  vtube: vtubeToken ? { authToken: vtubeToken } : undefined,
  twitch: twitchChannels.length > 0 ? { channels: twitchChannels } : undefined,
  youtube:
    youtubeKey && youtubeLiveChatId
      ? { apiKey: youtubeKey, liveChatId: youtubeLiveChatId }
      : undefined,
  bluesky: blueskyHandles.length > 0 ? { handles: blueskyHandles } : undefined,
  brain:
    llmUrl && llmModel
      ? {
          baseUrl: llmUrl,
          model: llmModel,
          apiKey: llmKey,
          historyFile: "logs/brain-history.jsonl",
          ...(process.env.CIRCE_REFLECT === "1" ? { reflect: true } : {}),
        }
      : undefined,
  critic:
    criticUrl && criticModel
      ? { baseUrl: criticUrl, model: criticModel, apiKey: criticKey }
      : undefined,
  autopilot: process.env.CIRCE_AUTOPILOT === "1" ? {} : undefined,
  recap: process.env.CIRCE_RECAP === "1" ? { onStop: true } : undefined,
  memory: { file: "logs/memory.jsonl" },
  tools: process.env.CIRCE_TOOLS === "1",
  stream: process.env.CIRCE_STREAM === "1" && process.env.CIRCE_REFLECT !== "1",
  vision:
    process.env.CIRCE_VISION === "1"
      ? { ...(visionInput ? { input: visionInput } : {}) }
      : undefined,
  voice:
    process.env.CIRCE_VOICE === "1"
      ? {
          ...(voiceInput ? { input: voiceInput } : {}),
          stt: sttUrl
            ? { backend: "http", httpUrl: sttUrl, model: process.env.CIRCE_STT_MODEL }
            : {},
        }
      : undefined,
  voiceChat: process.env.CIRCE_VOICECHAT === "1" ? { minGapMs: voiceChatMinGapMs } : undefined,
  goals:
    process.env.CIRCE_GOALS === "1"
      ? [
          goalChatVolume("chat-moving", 3, 3_600_000),
          goalDistinctChatters("three-chatters", 3, 3_600_000),
        ]
      : undefined,
  gamer:
    process.env.CIRCE_GAMER === "1"
      ? {
          live: process.env.CIRCE_GAMER_LIVE === "1",
          ...(process.env.CIRCE_GAMER_INTERVAL
            ? { intervalMs: Math.max(200, Number(process.env.CIRCE_GAMER_INTERVAL) || 5000) }
            : {}),
        }
      : undefined,
});

await runtime.start();
console.log("Circe-Core runtime: http://127.0.0.1:8788");
console.log(
  "Endpoints: GET /health | GET /context | GET /mana | GET /params | GET /memory | GET /events | POST /chat | POST /game | POST /game/step | POST /metrics | POST /reply | POST /ask | POST /duet | POST /remember | POST /recap",
);
console.log("Memory: episodic store at logs/memory.jsonl");
if (runtime.vtube) {
  console.log("VTube Studio bridge: enabled (waiting for handshake on :8001)");
} else {
  console.log('VTube Studio bridge: disabled (set CIRCE_VTS_TOKEN to enable)');
}
if (runtime.twitch) {
  console.log(`Twitch chat ingest: enabled (channels: ${twitchChannels.join(", ")})`);
} else {
  console.log("Twitch chat ingest: disabled (set CIRCE_TWITCH_CHANNELS to enable)");
}
if (runtime.youtube) {
  console.log(`YouTube chat ingest: enabled (live chat ${youtubeLiveChatId})`);
} else {
  console.log(
    "YouTube chat ingest: disabled (set CIRCE_YOUTUBE_KEY + CIRCE_YOUTUBE_LIVE_CHAT_ID to enable)",
  );
}
if (runtime.bluesky) {
  console.log(`Bluesky ingest: enabled (handles: ${blueskyHandles.join(", ")})`);
} else {
  console.log("Bluesky ingest: disabled (set CIRCE_BLUESKY_HANDLES to enable)");
}
if (runtime.brain) {
  console.log(`Brain: enabled (${llmUrl}, model ${llmModel})`);
} else {
  console.log("Brain: disabled (set CIRCE_LLM_URL + CIRCE_LLM_MODEL to enable)");
}
if (runtime.persona()) {
  console.log(`Persona: ${runtime.persona()?.name} (${runtime.persona()?.id})`);
} else {
  console.log(`Persona: ${DEFAULT_PERSONA.name} (${DEFAULT_PERSONA.id})`);
}
if (runtime.gamer) {
  console.log(
    `Gamer: enabled (${process.env.CIRCE_GAMER_LIVE === "1" ? "live inputs" : "dry run — narrating only"})`,
  );
}
if (runtime.brain && process.env.CIRCE_REFLECT === "1") {
  console.log("Reflection: enabled (draft → critique → final; set CIRCE_REFLECT=1 to toggle)");
}
if (runtime.critic) {
  console.log(
    `Critic agent: enabled (${criticModel} critiques her drafts; set CIRCE_CRITIC_MODEL to change)`,
  );
}
if (runtime.tools) {
  console.log("Tools: enabled (brain may query context/mana/memory; set CIRCE_TOOLS=1 to toggle)");
}
if (process.env.CIRCE_STREAM === "1" && process.env.CIRCE_REFLECT === "1") {
  console.log("Streaming: disabled because CIRCE_REFLECT=1 is also set (they are mutually exclusive)");
} else if (process.env.CIRCE_STREAM === "1") {
  console.log("Streaming: enabled (sentences speak as the brain generates them)");
}
if (runtime.vision) {
  console.log(
    `Vision: enabled (grabbing frames from ${process.env.CIRCE_VISION_INPUT ?? "the default camera"} every 15s)`,
  );
}
if (runtime.voice) {
  console.log(
    `Voice: enabled (VAD-gated mic loop; STT via ${sttUrl ?? "disabled backend — set CIRCE_STT_URL"})`,
  );
}
if (runtime.voiceChat) {
  console.log(`Voice chat: enabled (spoken replies to master turns; min gap ${voiceChatMinGapMs}ms)`);
}
if (runtime.goals.status().pending.length > 0 || runtime.goals.active()) {
  console.log(
    `Goals: enabled (${runtime.goals.status().pending.length + (runtime.goals.active() ? 1 : 0)} goals queued; set CIRCE_GOALS=1 to toggle)`,
  );
}
if (runtime.recapOnStop) {
  console.log("Recaps: enabled (session recap written to memory on shutdown)");
}
if (runtime.autopilot) {
  console.log("Autopilot: enabled (reacts to chat on her own)");
} else if (runtime.brain) {
  console.log("Autopilot: disabled (set CIRCE_AUTOPILOT=1 to enable)");
}

const demo = await runtime.processReply(
  '*giggles* Oh? A donation? Let me brew something special for that, Master~',
);
console.log("\n[demo reply]");
console.log(JSON.stringify(demo, null, 2));
console.log("\n[context prompt]\n" + runtime.contextPrompt());
console.log("\n[mana prompt]\n" + (await runtime.manaPrompt()));

