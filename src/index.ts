export { CirceBrain } from "./brain.js";
export type {
  AskToolsOptions,
  BrainOptions,
  BrainTurn,
  LlmContentPart,
  LlmMessage,
  ReflectInfo,
  ReplyOptions,
  StreamReplyOptions,
} from "./brain.js";
export { DEFAULT_PERSONA, DEFAULT_PERSONA_ID, EvilNeuro, getPersona, listPersonaIds, resolvePersona } from "./persona.js";
export type { Persona } from "./persona.js";

export { builtinTools, parseToolCall, ToolRegistry } from "./tools.js";
export type { CirceTool, ToolCallRequest, ToolContext, ToolOutcome } from "./tools.js";

export { StreamingSpeech } from "./streamspeak.js";
export type { StreamSpeechOptions } from "./streamspeak.js";

export { frameCommand, VisionSampler } from "./vision.js";
export type { LlmImagePart, VisionFrame, VisionOptions } from "./vision.js";

export { buildWav, detectSpeech, parseWav, rms } from "./vad.js";
export type { ParsedWav, VadOptions, VadResult } from "./vad.js";

export { transcribe } from "./stt.js";
export type { SttBackend, SttOptions, SttResult } from "./stt.js";

export { captureCommand, VoiceLoop } from "./voice.js";
export type { VoiceOptions, VoiceTurn } from "./voice.js";

export { VoiceChat } from "./voicechat.js";
export type { VoiceChatLine, VoiceChatOptions, VoiceChatStatus } from "./voicechat.js";

export { DEFAULT_ACTIONS, Gamer, defaultPolicy, gameplayPrompt, parsePlan } from "./gamer.js";
export type {
  GamerAction,
  GamerBrain,
  GamerObservation,
  GamerOptions,
  GamerPlan,
  GamerPolicy,
  GamerScene,
} from "./gamer.js";

export { clampLine, runDuet } from "./duet.js";
export type { DuetBrain, DuetLine, DuetOptions, DuetResult, DuetSpeakers } from "./duet.js";

export {
  GoalTracker,
  fallbackPlan,
  goalChatVolume,
  goalDistinctChatters,
  normalizeStep,
  parseBulletSteps,
  planGoal,
} from "./goals.js";
export type {
  ActiveGoalStatus,
  Goal,
  GoalChange,
  GoalContext,
  GoalStatus,
  GoalStep,
  StepAdvanceResult,
  StepChange,
  TurnRecordResult,
} from "./goals.js";

export { EmotionTracker } from "./emotion.js";
export type { EmotionState, EmotionOptions } from "./emotion.js";

export { Autopilot, promptFor } from "./autopilot.js";
export type { AutopilotHandler, AutopilotMessage, AutopilotOptions } from "./autopilot.js";

export { EpisodicMemory } from "./memory.js";
export type { GraphMemoryResult, MemoryFact, MemoryOptions } from "./memory.js";

export { fallbackRecap, parseBulletFacts, sessionRecap, RECAP_TAG } from "./recap.js";
export type { RecapResult, SessionDigest } from "./recap.js";

export { TagGraph } from "./graph.js";
export type { TagGraphStats, TagNeighbor } from "./graph.js";

export { EventBus } from "./bus.js";
export type { CirceEvent } from "./bus.js";

export { classifyMarker, parseReply } from "./expression.js";
export type { AnimationCue, CueKind, ParseOptions, ParsedReply } from "./expression.js";

export { speak } from "./tts.js";
export type { TtsBackend, TtsOptions, TtsResult } from "./tts.js";

export { playAudioFile, playbackCommand } from "./playback.js";

export { buildTimeline, estimateSpeechMs, msPerWord, wavDurationMs } from "./lipsync.js";
export type { LipTimeline, WordSegment } from "./lipsync.js";

export { TwitchChat, parsePrivmsg } from "./twitch.js";
export type { TwitchMessage, TwitchOptions, TwitchSocket } from "./twitch.js";

export { BlueskyChat, parseJetstream, postMatches } from "./bluesky.js";
export type { BlueskyMessage, BlueskyOptions, BlueskySocket } from "./bluesky.js";

export { YoutubeChat } from "./youtube.js";
export type { YoutubeChatMessage, YoutubeOptions } from "./youtube.js";

export { ManaPool } from "./manametry.js";
export type {
  ContextSample,
  CpuSample,
  GpuSample,
  ManaPoolOptions,
  ManaSnapshot,
  MemorySample,
} from "./manametry.js";

export { StreamContextFeed } from "./stream.js";
export type {
  AskOptions,
  ChatMessage,
  GameState,
  StreamContext,
  StreamFeedOptions,
} from "./stream.js";

export { VtubeStudioDriver } from "./vtube.js";
export type {
  VtubeSocket,
  VtubeState,
  VtubeStudioOptions,
  VtubeTarget,
  VtubeTargetKind,
} from "./vtube.js";

export { computeTier, normalizeUser, ViewerRegistry } from "./viewers.js";
export type { ViewerProfile, ViewerRegistryOptions, ViewerTier } from "./viewers.js";

export { CirceRuntime } from "./runtime.js";
export type { ChatReply, CirceRuntimeOptions, ProcessedReply } from "./runtime.js";

