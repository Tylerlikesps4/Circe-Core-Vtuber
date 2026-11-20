import type { EventBus } from "./bus.js";

/**
 * Voice chat mode: when the VAD+STT mic loop is on, spoken turns can trigger
 * spoken replies instead of only reading the context. Turns arrive on the bus
 * (`voice-turn`) and are spoken back through the runtime's reply pipeline —
 * cues, expressions, and TTS — so the VTuber animates and speaks while the
 * Master talks.
 *
 * Rules that keep the loop usable for ambient set:
 * - turns from speakers in `ignore` (e.g. a bot account) never trigger replies
 * - in-flight replies delay new ones by `minGapMs` (default 12s) and the rest
 *   queue behind the current reply, oldest first; nothing is dropped
 * - a speaking failure emits a `voice-chat-error` event and the queue keeps moving
 */
export interface VoiceChatOptions {
  /** Speakers whose turns never trigger replies (already lowercased logins). */
  ignore?: (user: string) => boolean;
  /** Delay between replies, in ms (default 12000). */
  minGapMs?: number;
}

export interface VoiceChatLine {
  user: string;
  text: string;
  ts: number;
}

export interface VoiceChatStatus {
  running: boolean;
  queued: number;
  speaking: boolean;
}

export class VoiceChat {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: VoiceChatLine[] = [];
  private speaking = false;
  private repliedAt = 0;
  private running = false;
  private readonly gapMs: number;
  private readonly ignore: ((user: string) => boolean) | undefined;

  constructor(
    private readonly bus: EventBus,
    private readonly speak: (line: VoiceChatLine) => Promise<void>,
    options: VoiceChatOptions = {},
  ) {
    this.gapMs = options.minGapMs ?? 12_000;
    this.ignore = options.ignore;
    bus.on((event) => {
      if (event.type === "voice-turn") {
        const user = typeof event.speaker === "string" ? event.speaker : "Master";
        const text = typeof event.text === "string" ? event.text : "";
        this.onTurn(user, text);
      }
    });
  }

  /** Enqueue a turn (e.g. manual injects driving the loop). */
  onTurn(user: string, text: string): void {
    const cleaned = text.trim();
    if (!this.running || !cleaned) return;
    if (this.ignore?.(user.toLowerCase())) return;
    this.queue.push({ user, text: cleaned, ts: Date.now() });
    this.flush();
  }

  start(): void {
    this.running = true;
    this.flush();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
  }

  get status(): VoiceChatStatus {
    return { running: this.running, queued: this.queue.length, speaking: this.speaking };
  }

  /** Configured minimum gap between replies, in ms. */
  get minGapMs(): number {
    return this.gapMs;
  }

  /** How many lines are waiting to be spoken (GET /voicechat). */
  queued(): number {
    return this.queue.length;
  }

  /** Whether a reply is currently being spoken. */
  isSpeaking(): boolean {
    return this.speaking;
  }

  private flush(): void {
    if (this.timer || this.speaking || this.queue.length === 0) return;
    const wait = Math.max(0, this.repliedAt + this.gapMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const line = this.queue.shift();
      if (!line) return;
      this.speaking = true;
      this.repliedAt = Date.now();
      this.bus.emit("voice-chat-reply", { user: line.user, text: line.text });
      void this.speak(line)
        .catch((err) =>
          this.bus.emit("voice-chat-error", {
            error: err instanceof Error ? err.message : String(err),
          }),
        )
        .finally(() => {
          this.speaking = false;
          this.flush();
        });
    }, wait);
    this.timer.unref?.();
  }
}
