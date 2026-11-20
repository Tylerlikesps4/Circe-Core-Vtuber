import { EventBus } from "./bus.js";
import { parseReply, ParsedReply, AnimationCue } from "./expression.js";
import { speak, TtsOptions, TtsResult } from "./tts.js";
import { StreamContextFeed } from "./stream.js";
import { ManaPool, ManaPoolOptions, ManaSnapshot } from "./manametry.js";
import { VtubeStudioDriver, VtubeStudioOptions } from "./vtube.js";
import { TwitchChat, TwitchOptions } from "./twitch.js";
import { YoutubeChat, YoutubeOptions } from "./youtube.js";
import { BlueskyChat, BlueskyOptions } from "./bluesky.js";
import { CirceBrain, BrainOptions } from "./brain.js";
import { Autopilot, AutopilotOptions } from "./autopilot.js";
import { EpisodicMemory, MemoryOptions } from "./memory.js";
import { builtinTools, ToolRegistry } from "./tools.js";
import { StreamingSpeech } from "./streamspeak.js";
import { VisionSampler, VisionOptions } from "./vision.js";
import { VoiceLoop, VoiceOptions } from "./voice.js";
import { VoiceChat, VoiceChatOptions, VoiceChatStatus } from "./voicechat.js";
import { Gamer, GamerOptions, gameplayPrompt } from "./gamer.js";
import { DuetOptions, DuetResult, runDuet } from "./duet.js";
import { GoalTracker, Goal, GoalStep } from "./goals.js";
import { DEFAULT_PERSONA, EvilNeuro, resolvePersona, type Persona } from "./persona.js";
import { ViewerRegistry, ViewerRegistryOptions } from "./viewers.js";
import { EmotionTracker, EmotionOptions } from "./emotion.js";
import { sessionRecap, SessionDigest, RecapResult, RECAP_TAG } from "./recap.js";
import { estimateSpeechMs, wavDurationMs } from "./lipsync.js";

export interface CirceRuntimeOptions {
  tts?: TtsOptions;
  port?: number;
  host?: string;
  logFile?: string;
  maxChat?: number;
  /** Configure to bridge animation cues into VTube Studio. */
  vtube?: VtubeStudioOptions;
  /** Twitch chat ingest; messages feed the stream context as chat lines. */
  twitch?: TwitchOptions;
  /** YouTube live chat ingest; messages feed the stream context as chat lines. */
  youtube?: YoutubeOptions;
  /** Bluesky ingest: posts replying to or mentioning the handles become chat lines. */
  bluesky?: BlueskyOptions;
  /** Cyber-sorcery meter options; GPU probing is on by default. */
  mana?: ManaPoolOptions;
  /** Local LLM brain (OpenAI-compatible); enables runtime.chat() and POST /ask. */
  brain?: BrainOptions;
  /**
   * Critic agent (writer + critic multi-agent): a second brain that performs
   * the critique pass whenever reflection runs, so draft and critique can
   * use different models or endpoints.
   */
  critic?: BrainOptions;
  /** Ambient co-host loop: react to chat on her own (requires a brain). */
  autopilot?: AutopilotOptions;
  /** Long-term episodic memory; facts are recalled into every brain prompt. */
  memory?: MemoryOptions;
  /**
   * Tool use: let the brain query context/mana/memory through the strict
   * JSON envelope before answering (requires a brain).
   */
  tools?: boolean;
  /**
   * Stream replies: hand each finished sentence to TTS as the brain's tokens
   * arrive, so speech starts mid-reply (requires a brain). Session-level
   * default for `chat()`; superseded by explicit per-call flags.
   */
  stream?: boolean;
  /**
   * Vision: grab still frames from the stream (OBS virtual camera / webcam
   * via ffmpeg) and attach them to brain turns for vision-capable models.
   */
  vision?: VisionOptions;
  /**
   * Voice input: a VAD-gated mic listen loop (ffmpeg chunk capture) feeding
   * an STT bridge; spoken turns land in the stream context as the `speaker`.
   */
  voice?: VoiceOptions;
  /**
   * Voice chat mode: spoken turns (from the VAD+STT mic loop) trigger spoken
   * replies through the normal reply pipeline, with the gap/queue rules in
   * `VoiceChat`. Requires the VAD mic loop (`voice`) and a brain for useful
   * replies; without a brain the lines still queue but nothing more happens.
   */
  voiceChat?: VoiceChatOptions;
  /**
   * Talker + gamer tandem: a separate gameplay mind that observes the game
   * state, picks inputs, and leaves commentary for Circe to narrate. Dry-run
   * (observe and narrate only) unless `gamer.live` is set.
   */
  gamer?: GamerOptions;
  /**
   * Per-viewer personas: chatter keys (e.g. Twitch logins) mapped to personas
   * that override the session persona for that viewer's turns.
   */
  viewerPersonas?: Record<string, Persona>;
  /**
   * Goals for open-ended pursuit: a queue of declarative goals the brain
   * works toward inside its reactive loop (see `src/goals.ts`).
   */
  goals?: Goal[];
  /**
   * Viewer registry: chatter relationships, affinity, tiers, and notes
   * tracked across turns and sessions (persists to JSONL).
   */
  viewers?: ViewerRegistryOptions;
  /**
   * Emotion state: mood/intensity observed from replies and cues, rendered
   * into the brain prompt as an `[EMOTION]` block.
   */
  emotion?: EmotionOptions;
  /**
   * Persona to run as: a built-in id (e.g. "evil-neuro") or a Persona object.
   * Defaults to the Circe persona when unset.
   */
  persona?: Persona | string;
  /**
   * Session recaps: distill the session into a few facts and store them in
   * episodic memory. `onStop: true` writes a recap automatically on shutdown,
   * so the next stream starts with her remembering the last one.
   */
  recap?: { onStop?: boolean; maxFacts?: number };
  /** Speaking rate used to estimate cue positions on the speech timeline. */
  wpm?: number;
}

export interface ProcessedReply {
  speech: string;
  cues: ParsedReply["cues"];
  tts: TtsResult;
}

export interface ChatReply {
  answer: string;
  processed: ProcessedReply;
}

/** A two-hander request: who Circe trades lines with, and for how long. */
export interface DuetRequest extends DuetOptions {
  /** Partner persona object or built-in id (defaults to Evil Neuro at the HTTP layer). */
  partner: Persona | string;
  /** Primary speaker for this bit; defaults to the runtime's active persona. */
  primary?: Persona;
}

/**
 * Orchestrates Circe's reply pipeline: parse a reply into spoken text and
 * animation cues, speak it through the TTS bridge, and emit typed events on
 * the bus for the animation and overlay layers. Holds the stream-context
 * feed, the VTube Studio bridge, the chat adapters, the brain, and the
 * cyber-sorcery mana pool.
 */
export class CirceRuntime {
  readonly bus: EventBus;
  readonly stream: StreamContextFeed;
  readonly mana: ManaPool;
  readonly memory: EpisodicMemory;
  readonly brain: CirceBrain | null;
  readonly critic: CirceBrain | null;
  readonly tools: ToolRegistry | null;
  readonly autopilot: Autopilot | null;
  readonly vision: VisionSampler | null;
  readonly voice: VoiceLoop | null;
  readonly voiceChat: VoiceChat | null;
  readonly gamer: Gamer | null;
  readonly goals: GoalTracker;
  readonly viewers: ViewerRegistry;
  readonly vtube: VtubeStudioDriver | null;
  readonly twitch: TwitchChat | null;
  readonly youtube: YoutubeChat | null;
  readonly bluesky: BlueskyChat | null;
  readonly viewerPersonas: Record<string, Persona>;
  private readonly ttsOptions: TtsOptions;
  private readonly wpm: number;
  private readonly streamDefault: boolean;
  readonly recapOnStop: boolean;
  private readonly recapMaxFacts: number;
  private readonly sessionStartedAt: number = Date.now();
  private readonly sessionReplies: string[] = [];
  readonly emotion: EmotionTracker;
  private activePersona?: Persona;

  constructor(options: CirceRuntimeOptions = {}) {
    this.bus = new EventBus({ logFile: options.logFile ?? "logs/circe-events.jsonl" });
    this.mana = new ManaPool(options.mana ?? {});
    this.memory = new EpisodicMemory(options.memory ?? {});
    this.streamDefault = options.stream ?? false;
    this.recapOnStop = options.recap?.onStop ?? false;
    this.recapMaxFacts = Math.max(1, options.recap?.maxFacts ?? 5);
    this.goals = new GoalTracker(options.goals ?? []);
    this.viewers = new ViewerRegistry(options.viewers);
    this.emotion = new EmotionTracker(options.emotion ?? {});
    this.viewerPersonas = options.viewerPersonas ?? {};
    const persona: Persona =
      typeof options.persona === "string" ? resolvePersona(options.persona) : options.persona ?? DEFAULT_PERSONA;
    this.activePersona = persona;
    this.vision = options.vision ? new VisionSampler(options.vision, this.bus) : null;
    this.voice = options.voice ? new VoiceLoop(options.voice, this.bus) : null;
    this.voiceChat = options.voiceChat
      ? new VoiceChat(
          this.bus,
          async (line) => {
            await this.processReply(line.text);
          },
          options.voiceChat,
        )
      : null;
    this.brain = options.brain
      ? new CirceBrain({
          ...options.brain,
          ...(options.persona ? { persona: this.activePersona } : {}),
          onReflect: (info) => {
            options.brain?.onReflect?.(info);
            this.bus.emit("brain-reflect", {
              ...info,
              ...(this.critic ? { critic: true } : {}),
            });
          },
          ...(this.vision ? { getFrame: () => options.brain?.getFrame?.() ?? this.vision?.framePart() ?? null } : {}),
        })
      : null;
    this.critic = options.critic ? new CirceBrain(options.critic) : null;
    this.autopilot =
      options.autopilot && this.brain
        ? new Autopilot(this.bus, (prompt) => this.chat(prompt).then(() => undefined), options.autopilot)
        : null;
    this.ttsOptions = { ...this.activePersona?.tts, ...options.tts };
    this.wpm = options.wpm ?? 155;
    this.gamer = options.gamer
      ? new Gamer(
          {
            getState: () => this.stream.context().game,
            ...options.gamer,
            brain: options.gamer.brain ?? this.brain ?? undefined,
          },
          this.bus,
        )
      : null;
    this.stream = new StreamContextFeed(this.bus, {
      port: options.port ?? 8788,
      host: options.host ?? "127.0.0.1",
      maxChat: options.maxChat ?? 50,
      mana: this.mana,
      memory: this.memory,
      vision: this.vision ?? undefined,
      goals: this.goals,
      viewers: this.viewers,
      voiceChat: this.voiceChat ? () => this.voiceChat?.status ?? null : undefined,
      onReply: (text) => this.processReply(text),
      onRecap: () => this.recap({ store: true }),
      onGoalAdvance: (reason) => this.advanceGoalStep(reason),
      ...(this.gamer ? { onGameStep: () => this.gamer?.tick() } : {}),
      ...(this.brain
        ? {
            onAsk: (message: string, opts?: { reflect?: boolean; tools?: boolean }) =>
              this.chat(message, opts ?? {}),
            onDuet: (
              topic: string,
              opts: { partner?: string; turns?: number; opener?: "primary" | "partner" },
            ) =>
              this.duet(topic, {
                partner: opts.partner ? resolvePersona(opts.partner) : EvilNeuro,
                ...(opts.turns ? { turns: opts.turns } : {}),
                ...(opts.opener ? { opener: opts.opener } : {}),
              }),
          }
        : {}),
    });
    this.vtube = options.vtube ? new VtubeStudioDriver(this.bus, options.vtube) : null;
    this.tools =
      options.tools && this.brain
        ? new ToolRegistry(
            builtinTools({
              context: () => this.contextPrompt(),
              mana: () => this.manaPrompt(),
              recall: (query, limit) => this.memory.recall(query, limit),
              recallGraph: (query, limit) => this.memory.graphRecall(query, limit),
              related: (tag, limit) => this.memory.relatedTags(tag, limit),
              remember: (text, tags) => this.memory.remember(text, tags),
              goals: {
                status: () => this.goals.status(),
                advance: (reason) => this.advanceGoalStep(reason),
              },
              viewers: {
                profile: (user) => this.viewers.get(user),
                note: (user, note) => {
                  const p = this.viewers.addNote(user, note);
                  this.bus.emit("viewer-update", { user: p.user, profile: p, note });
                  return p;
                },
                affinity: (user, delta, reason) => {
                  const p = this.viewers.adjustAffinity(user, delta, reason);
                  this.bus.emit("viewer-update", { user: p.user, profile: p, delta, reason });
                  return p;
                },
              },
            }),
          )
        : null;
    this.twitch = options.twitch ? new TwitchChat(this.bus, options.twitch) : null;
    this.youtube = options.youtube ? new YoutubeChat(this.bus, options.youtube) : null;
    this.bluesky = options.bluesky ? new BlueskyChat(this.bus, options.bluesky) : null;
    this.bus.on((event) => {
      if (event.type === "expression" && this.vtube) {
        this.vtube.handleCue(event as unknown as AnimationCue);
      } else if (event.type === "twitch-message" && this.twitch) {
        const user = typeof event.user === "string" ? event.user : "anon";
        const message = typeof event.message === "string" ? event.message : "";
        if (message) this.stream.pushChat(user, message);
        this.autopilot?.note(user, message);
        const profile = this.viewers.recordMessage(user, message);
        this.bus.emit("viewer-update", { user: profile.user, profile });
      } else if (event.type === "youtube-message" && this.youtube) {
        const user = typeof event.user === "string" ? event.user : "anon";
        const message = typeof event.message === "string" ? event.message : "";
        if (message) this.stream.pushChat(user, message);
        this.autopilot?.note(user, message);
        const profile = this.viewers.recordMessage(user, message);
        this.bus.emit("viewer-update", { user: profile.user, profile });
      } else if (event.type === "bluesky-message" && this.bluesky) {
        const user = typeof event.user === "string" ? event.user : "anon";
        const message = typeof event.message === "string" ? event.message : "";
        if (message) this.stream.pushChat(user, message);
        this.autopilot?.note(user, message);
        const profile = this.viewers.recordMessage(user, message);
        this.bus.emit("viewer-update", { user: profile.user, profile });
      } else if (event.type === "voice-turn") {
        const user = typeof event.speaker === "string" ? event.speaker : "Master";
        const message = typeof event.text === "string" ? event.text : "";
        if (message) {
          this.stream.pushChat(user, message);
          this.autopilot?.note(user, message);
          this.voiceChat?.onTurn(user, message);
        }
      } else if (event.type === "chat") {
        const user = typeof event.user === "string" ? event.user : "anon";
        const message = typeof event.message === "string" ? event.message : "";
        const profile = this.viewers.recordMessage(user, message);
        this.bus.emit("viewer-update", { user: profile.user, profile });
        const change = this.goals.evaluate({
          chat: this.stream.context().chat,
          now: Date.now(),
        });
        if (change.completed) {
          this.bus.emit("goal-done", { id: change.completed.id, description: change.completed.description });
        }
        if (change.stepAdvanced) {
          this.bus.emit("goal-step", {
            id: this.goals.active()?.id,
            index: change.stepAdvanced.index,
            totalSteps: change.stepAdvanced.totalSteps,
            step: change.stepAdvanced.step,
            reason: change.stepAdvanced.reason,
          });
        }
        if (change.activated) {
          this.bus.emit("goal-active", {
            id: change.activated.id,
            description: change.activated.description,
            steps: this.goals.activeSteps(),
          });
        }
      }
    });
  }

  async processReply(reply: string): Promise<ProcessedReply> {
    const parsed = parseReply(reply, { wpm: this.wpm });
    const estimated = estimateSpeechMs(parsed.speech, this.wpm);
    if (parsed.speech) {
      this.sessionReplies.push(parsed.speech);
      if (this.sessionReplies.length > 100) this.sessionReplies.shift();
    }
    for (const cue of parsed.cues) {
      this.emotion.observe(cue);
      const delay = cue.atMs ?? 0;
      if (delay <= 0) {
        this.bus.emit("expression", { ...cue });
      } else {
        const timer = setTimeout(() => {
          this.bus.emit("expression", { ...cue });
        }, delay);
        timer.unref?.();
      }
    }
    this.bus.emit("speech", { text: parsed.speech, estimatedMs: estimated });
    this.bus.emit("lip-start", { text: parsed.speech, estimatedMs: estimated });
    const tts = await speak(parsed.speech, this.ttsOptions);
    const measured = tts.file?.toLowerCase().endsWith(".wav") ? wavDurationMs(tts.file) : null;
    this.bus.emit("lip-end", {
      text: parsed.speech,
      durationMs: measured ?? estimated,
      measured: measured !== null,
    });
    this.bus.emit("tts", { ...tts });
    return { speech: parsed.speech, cues: parsed.cues, tts };
  }

  /**
   * Think, then speak: send the message to the brain with the live stream
   * context and cyber-sorcery snapshot, and run the answer through the reply
   * pipeline (cues, TTS, events).
   *
   * - `{ reflect: true }` forces the two-pass draft → critique → final pass.
   * - `{ tools: true }` lets the brain query context/mana/memory through the
   *   JSON tool envelope first (requires the runtime tools option).
   * - `{ stream: true }` streams tokens into TTS so speech starts mid-reply.
   *
   * Streaming cannot be combined with an explicit reflect or tools request;
   * otherwise explicit per-call flags win over session defaults.
   */
  async chat(
    userMessage: string,
    opts: { reflect?: boolean; tools?: boolean; stream?: boolean; persona?: Persona } = {},
    user?: string,
  ): Promise<ChatReply> {
    if (!this.brain) throw new Error("brain not configured");
    if (opts.stream && (opts.reflect || opts.tools)) {
      throw new Error("stream cannot be combined with reflect or tools");
    }
    // Explicit per-call flags win over session defaults; a session stream
    // default yields to an explicit reflect/tools request. The optional
    // caller `user` key selects a per-viewer persona for this turn.
    const wantStream =
      opts.stream === undefined
        ? this.streamDefault && opts.reflect !== true && opts.tools !== true
        : opts.stream;
    const viewer = user ? this.viewers.get(user) : null;
    const persona =
      opts.persona ??
      (viewer?.personaId ? resolvePersona(viewer.personaId) : undefined) ??
      (user ? this.viewerPersonas[user] : undefined);
    if (wantStream) return this.chatStream(userMessage, persona, user);

    const context = [
      this.contextPrompt(),
      await this.manaPrompt(),
      this.emotion.toPrompt(),
      this.goalPrompt(),
      user ? this.viewers.renderPrompt(user) : "",
      this.memory.renderGraph(userMessage),
    ]
      .filter(Boolean)
      .join("\n\n");
    let answer: string;
    if (opts.tools) {
      if (!this.tools) throw new Error("tools not enabled");
      answer = await this.brain.askWithTools(userMessage, context, {
        tools: this.tools,
        persona,
        onTool: (call, outcome) => {
          this.bus.emit("tool-call", { tool: call.tool, args: call.args });
          if (outcome.ok) {
            this.bus.emit("tool-result", { tool: call.tool, result: outcome.result });
          } else {
            this.bus.emit("tool-error", { tool: call.tool, error: outcome.error });
          }
        },
      });
    } else {
      answer = await this.brain.reply(userMessage, context, {
        reflect: opts.reflect,
        persona,
        ...(this.critic ? { critic: (messages) => this.critic!.execute(messages) } : {}),
      });
    }
    const processed = await this.processReply(answer);
    const turnResult = this.goals.recordTurn();
    if (turnResult.autoAdvanced) {
      this.bus.emit("goal-step", {
        id: this.goals.active()?.id,
        index: turnResult.index,
        totalSteps: turnResult.totalSteps,
        step: turnResult.step,
        reason: turnResult.reason,
      });
    }
    return { answer, processed };
  }

  /**
   * Streaming reply pipeline: brain tokens flow through an incremental
   * sentence splitter that speaks each finished sentence as it completes,
   * fires animation cues the moment their markers close, and emits
   * `stream-start` / per-sentence `speech` / `stream-end` events.
   */
  async chatStream(userMessage: string, persona?: Persona, user?: string): Promise<ChatReply> {
    if (!this.brain) throw new Error("brain not configured");
    const context = [
      this.contextPrompt(),
      await this.manaPrompt(),
      this.emotion.toPrompt(),
      this.goalPrompt(),
      user ? this.viewers.renderPrompt(user) : "",
      this.memory.renderGraph(userMessage),
    ]
      .filter(Boolean)
      .join("\n\n");

    this.bus.emit("stream-start", {});
    const speaker = new StreamingSpeech({
      speak: async (sentence) => {
        const estimated = estimateSpeechMs(sentence, this.wpm);
        this.bus.emit("speech", { text: sentence, estimatedMs: estimated, streaming: true });
        this.bus.emit("lip-start", { text: sentence, estimatedMs: estimated, streaming: true });
        const tts = await speak(sentence, this.ttsOptions);
        const measured = tts.file?.toLowerCase().endsWith(".wav") ? wavDurationMs(tts.file) : null;
        this.bus.emit("lip-end", {
          text: sentence,
          durationMs: measured ?? estimated,
          measured: measured !== null,
          streaming: true,
        });
        this.bus.emit("tts", { ...tts, streaming: true });
        return tts;
      },
      onCue: (cue) => this.bus.emit("expression", { ...cue }),
    });

    const answer = await this.brain.streamReply(userMessage, context, {
      onChunk: (chunk) => speaker.feed(chunk),
      persona,
    });
    await speaker.flush();
    this.bus.emit("stream-end", { text: answer });
    const turnResult = this.goals.recordTurn();
    if (turnResult.autoAdvanced) {
      this.bus.emit("goal-step", {
        id: this.goals.active()?.id,
        index: turnResult.index,
        totalSteps: turnResult.totalSteps,
        step: turnResult.step,
        reason: turnResult.reason,
      });
    }

    return {
      answer,
      processed: {
        speech: speaker.speechText() || answer,
        cues: speaker.cues(),
        tts:
          speaker.tts() ?? {
            ok: true,
            backend: this.ttsOptions.backend ?? "none",
            text: answer,
            detail: "streamed (no sentences spoken)",
          },
      },
    };
  }

  /** Store an episodic memory fact (also exposed over POST /remember). */
  remember(text: string, tags: string[] = []): ReturnType<EpisodicMemory["remember"]> {
    return this.memory.remember(text, tags);
  }

  /**
   * Explicitly advance the active goal to the next sub-step in its multi-turn plan.
   * Emits a `goal-step` event if advancement succeeded.
   */
  advanceGoalStep(reason?: string): {
    advanced: boolean;
    index: number;
    totalSteps: number;
    step?: GoalStep;
    reason?: string;
  } {
    const adv = this.goals.advanceStep(reason);
    if (adv.advanced) {
      this.bus.emit("goal-step", {
        id: this.goals.active()?.id,
        index: adv.index,
        totalSteps: adv.totalSteps,
        step: adv.step,
        reason: adv.reason,
      });
    }
    return {
      advanced: adv.advanced,
      index: adv.index,
      totalSteps: adv.totalSteps,
      step: adv.step,
      reason: adv.reason,
    };
  }

  /**
   * Render the active goal (if any) as an in-character pursuit block for
   * Circe's prompt; empty when no goal is active.
   */
  goalPrompt(): string {
    return this.goals.prompt();
  }

  /** The persona currently driving the runtime (defaults to the Circe persona). */
  persona(): Persona | undefined {
    return this.activePersona;
  }

  /**
   * Swap the persona mid-flight (e.g. Circe → Evil Neuro); the brain and TTS
   * chain follow so subsequent replies come from the new identity.
   */
  setPersona(persona: Persona): void {
    this.activePersona = persona;
    this.brain?.setPersona(persona);
  }

  /**
   * Render the current stream context as a short block to prepend to Circe's
   * system prompt so she is aware of the live scene.
   */
  contextPrompt(limit = 5): string {
    const ctx = this.stream.context();
    const lines: string[] = ["[STREAM CONTEXT]"];
    const recent = ctx.chat.slice(-limit);
    if (recent.length === 0) {
      lines.push("Chat: (no messages yet)");
    } else {
      lines.push(`Chat (last ${recent.length}):`);
      for (const m of recent) lines.push(`- ${m.user}: ${m.message}`);
    }
    if (ctx.game) {
      const { ts: _ts, ...state } = ctx.game;
      if (Object.keys(state).length > 0) lines.push(`Game: ${JSON.stringify(state)}`);
    }
    const gameplay = this.gamer ? gameplayPrompt(this.gamer) : "";
    if (gameplay) lines.push(gameplay);
    return lines.join("\n");
  }

  /**
   * Render the live cyber-sorcery snapshot (memory pool, spell lattice, mana
   * reserves) as an in-character block for Circe's prompt.
   */
  async manaPrompt(): Promise<string> {
    return this.mana.render(await this.mana.snapshot());
  }

  /**
   * Two-hander mode: Circe and another persona (Evil Neuro by default) trade
   * lines on one topic. Each line is spoken through the normal reply pipeline,
   * and the completions use `brain.execute()` so the talker's rolling history
   * stays clean. Exposed over `POST /duet`.
   */
  async duet(topic: string, options: DuetRequest): Promise<DuetResult> {
    if (!this.brain) throw new Error("duet requires the brain (set brain options)");
    const { partner: partnerInput, primary: primaryInput, ...rest } = options;
    const primary = primaryInput ?? this.activePersona ?? DEFAULT_PERSONA;
    const partner = typeof partnerInput === "string" ? resolvePersona(partnerInput) : partnerInput;
    return runDuet(this.brain, { primary, partner }, topic, {
      ...rest,
      onLine: async (line) => {
        this.bus.emit("duet-turn", { ...line });
        await options.onLine?.(line);
        await this.processReply(line.text);
      },
    });
  }

  /**
   * Distill the session into a few self-contained facts (brain-assisted when
   * available, deterministic stats otherwise) and, unless `store: false`,
   * fold them into episodic memory tagged "recap" so the next stream recalls
   * them. Also exposed over `POST /recap`.
   */
  async recap(opts: { store?: boolean } = {}): Promise<RecapResult> {
    const digest: SessionDigest = {
      chat: this.stream.context().chat,
      replies: [...this.sessionReplies],
      goalsDone: this.goals.status().done,
      startedAt: this.sessionStartedAt,
      endedAt: Date.now(),
    };
    const result = await sessionRecap(this.brain, digest, this.recapMaxFacts);
    if (opts.store !== false) {
      for (const fact of result.facts) this.memory.remember(fact, [RECAP_TAG]);
      this.bus.emit("recap", {
        facts: result.facts,
        summary: result.summary,
        source: result.source,
      });
    }
    return result;
  }

  async start(): Promise<void> {
    await this.stream.start();
    const change = this.goals.evaluate({ chat: this.stream.context().chat, now: Date.now() });
    if (change.activated) {
      this.bus.emit("goal-active", {
        id: change.activated.id,
        description: change.activated.description,
        steps: this.goals.activeSteps(),
      });
    }
    this.vision?.start();
    this.voice?.start();
    this.voiceChat?.start();
    this.gamer?.start();
    this.vtube?.start();
    this.twitch?.start();
    this.youtube?.start();
    this.bluesky?.start();
    this.autopilot?.start();
  }

  async stop(): Promise<void> {
    if (this.recapOnStop) {
      try {
        await this.recap({ store: true });
      } catch {
        // a failed recap must never block shutdown
      }
    }
    this.autopilot?.stop();
    this.youtube?.stop();
    this.twitch?.stop();
    this.bluesky?.stop();
    this.vtube?.stop();
    this.gamer?.stop();
    this.voice?.stop();
    this.voiceChat?.stop();
    this.vision?.stop();
    await this.stream.stop();
  }

  /** Type-only helper so consumers can reach the snapshot shape via runtime. */
  snapshot(): Promise<ManaSnapshot> {
    return this.mana.snapshot();
  }
}
