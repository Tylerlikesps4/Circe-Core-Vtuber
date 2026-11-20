import type { EventBus } from "./bus.js";

export interface AutopilotOptions {
  /** Messages needed to react immediately (default 3). */
  batch?: number;
  /** React to a lone message after this much silence, in ms (default 12000). */
  idleMs?: number;
  /** Minimum time between reactions, in ms (default 8000). */
  minGapMs?: number;
  /** Hard cap on reactions within any 60s window (default 4). */
  maxRepliesPerMinute?: number;
  /** Oldest buffered messages are dropped beyond this many (default 20). */
  maxPending?: number;
  /** Skip messages from these users (case-insensitive), e.g. Circe's own bot account. */
  ignore?: (user: string) => boolean;
}

export interface AutopilotMessage {
  user: string;
  message: string;
}

export type AutopilotHandler = (prompt: string, messages: AutopilotMessage[]) => Promise<void>;

const DEFAULT_BATCH = 3;
const DEFAULT_IDLE_MS = 12_000;
const DEFAULT_MIN_GAP_MS = 8_000;
const DEFAULT_MAX_PER_MINUTE = 4;
const DEFAULT_MAX_PENDING = 20;

/**
 * Circe's ambient co-host loop. Listens to chat traffic (fed by the runtime
 * from Twitch/YouTube adapters) and decides when she should speak up on her
 * own: react once `batch` messages accumulate, or after `idleMs` of quiet,
 * while never violating `minGapMs` or `maxRepliesPerMinute` so she stays a
 * co-host and not a spam bot. The handler receives a ready-to-send prompt
 * describing the messages she is reacting to.
 */
export class Autopilot {
  private buffer: AutopilotMessage[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDue = 0;
  private running = false;
  private replying = false;
  private lastFireAt = 0;
  private fireTimes: number[] = [];
  private readonly options: Required<
    Pick<AutopilotOptions, "batch" | "idleMs" | "minGapMs" | "maxRepliesPerMinute" | "maxPending">
  > &
    Pick<AutopilotOptions, "ignore">;

  constructor(
    private readonly bus: EventBus,
    private readonly onReply: AutopilotHandler,
    options: AutopilotOptions = {},
  ) {
    this.options = {
      batch: Math.max(1, options.batch ?? DEFAULT_BATCH),
      idleMs: Math.max(0, options.idleMs ?? DEFAULT_IDLE_MS),
      minGapMs: Math.max(0, options.minGapMs ?? DEFAULT_MIN_GAP_MS),
      maxRepliesPerMinute: Math.max(1, options.maxRepliesPerMinute ?? DEFAULT_MAX_PER_MINUTE),
      maxPending: Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING),
      ignore: options.ignore,
    };
  }

  /** Number of chat lines buffered and awaiting a reaction. */
  get pending(): number {
    return this.buffer.length;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  /** Feed one chat line; reacts immediately at the batch threshold, otherwise on idle. */
  note(user: string, message: string): void {
    if (!this.running) return;
    if (this.options.ignore?.(user)) return;
    if (this.buffer.length >= this.options.maxPending) this.buffer.shift();
    this.buffer.push({ user, message });
    if (this.replying) return;
    const delay = this.buffer.length >= this.options.batch ? 0 : this.options.idleMs;
    this.schedule(delay);
  }

  private schedule(delayMs: number): void {
    const due = Date.now() + delayMs;
    if (this.timer) {
      if (this.timerDue <= due) return;
      this.clearTimer();
    }
    this.timerDue = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, delayMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async fire(): Promise<void> {
    if (!this.running || this.replying) return;
    const now = Date.now();
    this.pruneWindow(now);

    const gapLeft = this.options.minGapMs - (now - this.lastFireAt);
    if (gapLeft > 0) {
      this.schedule(gapLeft);
      return;
    }
    if (this.fireTimes.length >= this.options.maxRepliesPerMinute) {
      const oldest = this.fireTimes[0] ?? now;
      this.schedule(60_000 - (now - oldest) + 25);
      return;
    }

    const messages = this.buffer.splice(0);
    if (messages.length === 0) return;

    this.replying = true;
    this.lastFireAt = now;
    this.fireTimes.push(now);
    try {
      await this.onReply(promptFor(messages), messages);
      this.bus.emit("autopilot-reply", {
        messages: messages.length,
        users: messages.map((m) => m.user),
      });
    } catch (err) {
      this.bus.emit("autopilot-error", { message: (err as Error).message });
    } finally {
      this.replying = false;
      if (this.running && this.buffer.length > 0) {
        this.schedule(this.buffer.length >= this.options.batch ? 0 : this.options.idleMs);
      }
    }
  }

  private pruneWindow(now: number): void {
    this.fireTimes = this.fireTimes.filter((t) => now - t < 60_000);
  }
}

/** Build the brain prompt for a batch of chat lines. */
export function promptFor(messages: AutopilotMessage[]): string {
  const lines = messages.map((m) => `- ${m.user}: ${m.message}`);
  return [
    "Chat just said:",
    ...lines,
    "",
    "React to it in character in one or two short sentences.",
  ].join("\n");
}
