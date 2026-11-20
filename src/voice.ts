import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runProcess, ProcResult } from "./proc.js";
import { detectSpeech, VadOptions } from "./vad.js";
import { transcribe, SttOptions } from "./stt.js";
import type { EventBus } from "./bus.js";

export interface VoiceOptions {
  /** Microphone device name (platform-specific; see `captureCommand`). */
  input?: string;
  /** Capture binary (default "ffmpeg"). */
  captureCommand?: string;
  /**
   * Capture-command builder: receives the target WAV path and returns args.
   * When set, it fully replaces the platform default (test hook / override).
   */
  captureArgs?: (file: string) => string[];
  /** Length of each captured chunk in seconds (default 4). */
  chunkSeconds?: number;
  /** Where captured chunks land (default "media/voice"). */
  outDir?: string;
  /** Keep at most this many chunks on disk (default 10). */
  maxChunks?: number;
  /** Listen-loop interval while started, in ms (default 400). */
  pollMs?: number;
  /** Minimum characters for a transcript to count as a voice turn (default 2). */
  minChars?: number;
  /** Who voice turns are attributed to in the stream context (default "Master"). */
  speaker?: string;
  /** VAD tuning (threshold / window). */
  vad?: VadOptions;
  /** STT bridge; a backend must be enabled to hear anything. */
  stt?: SttOptions;
  /** Test hook: inject the capture process runner. */
  runImpl?: (cmd: string, args: string[]) => Promise<ProcResult>;
}

export interface VoiceTurn {
  text: string;
  ts: number;
  speaker: string;
}

/**
 * Build the ffmpeg command that records one WAV chunk from the mic input
 * (16 kHz mono, the dialect the VAD and STT layers expect).
 */
export function captureCommand(
  platform: NodeJS.Platform,
  input: string | undefined,
  outFile: string,
  chunkSeconds: number,
  command = "ffmpeg",
): { cmd: string; args: string[] } {
  const secs = String(chunkSeconds);
  if (platform === "win32") {
    return {
      cmd: command,
      args: [
        "-y",
        "-f",
        "dshow",
        "-i",
        input ?? "audio=Microphone",
        "-t",
        secs,
        "-ar",
        "16000",
        "-ac",
        "1",
        outFile,
      ],
    };
  }
  if (platform === "darwin") {
    return {
      cmd: command,
      args: [
        "-y",
        "-f",
        "avfoundation",
        "-i",
        input ?? ":0",
        "-t",
        secs,
        "-ar",
        "16000",
        "-ac",
        "1",
        outFile,
      ],
    };
  }
  return {
    cmd: command,
    args: [
      "-y",
      "-f",
      "alsa",
      "-i",
      input ?? "default",
      "-t",
      secs,
      "-ar",
      "16000",
      "-ac",
      "1",
      outFile,
    ],
  };
}

/**
 * The listen loop: capture a short mic chunk, gate it through the VAD, send
 * the speech through the STT bridge, and emit a `voice-turn` event that the
 * runtime folds into the stream context (and the autopilot notices).
 */
export class VoiceLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly run: (cmd: string, args: string[]) => Promise<ProcResult>;
  private readonly chunkSeconds: number;
  private readonly maxChunks: number;
  private readonly minChars: number;
  private readonly pollMs: number;

  constructor(
    private readonly options: VoiceOptions = {},
    private readonly bus: EventBus | null = null,
  ) {
    this.run = options.runImpl ?? runProcess;
    this.chunkSeconds = Math.max(1, options.chunkSeconds ?? 4);
    this.maxChunks = Math.max(1, options.maxChunks ?? 10);
    this.minChars = Math.max(1, options.minChars ?? 2);
    this.pollMs = Math.max(100, options.pollMs ?? 400);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Start the listen loop (no-op if already running). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollMs);
    this.timer.unref?.();
    void this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One pass of the loop: capture a chunk, VAD-gate it, transcribe it, and
   * emit + return a voice turn when speech came through; null otherwise.
   */
  async poll(): Promise<VoiceTurn | null> {
    const outDir = this.options.outDir ?? join("media", "voice");
    const ts = Date.now();
    const file = join(outDir, `voice-${ts}.wav`);
    try {
      mkdirSync(outDir, { recursive: true });
    } catch {
      // the capture runner will report its own failure if the directory is unusable
    }
    const { cmd, args } = this.options.captureArgs
      ? { cmd: this.options.captureCommand ?? "ffmpeg", args: this.options.captureArgs(file) }
      : captureCommand(
          process.platform,
          this.options.input,
          file,
          this.chunkSeconds,
          this.options.captureCommand,
        );
    const result = await this.run(cmd, args);
    if (!result.ok || !existsSync(file)) {
      this.bus?.emit("voice-error", { detail: result.detail ?? "capture produced no audio" });
      return null;
    }

    let wav: Buffer;
    try {
      wav = readFileSync(file);
    } catch (err) {
      this.bus?.emit("voice-error", { detail: `cannot read chunk: ${(err as Error).message}` });
      return null;
    }
    if (!detectSpeech(wav, this.options.vad).speech) {
      rmSync(file, { force: true });
      return null;
    }

    const stt = await transcribe(file, this.options.stt);
    if (!stt.ok) {
      rmSync(file, { force: true });
      this.bus?.emit("voice-error", { detail: stt.detail });
      return null;
    }
    const text = stt.text.trim();
    if (text.length < this.minChars) {
      rmSync(file, { force: true });
      return null;
    }

    this.prune(outDir);
    const turn: VoiceTurn = { text, ts, speaker: this.options.speaker ?? "Master" };
    this.bus?.emit("voice-turn", { ...turn });
    return turn;
  }

  private prune(outDir: string): void {
    try {
      const chunks = readdirSync(outDir)
        .filter((name) => /^voice-\d+\.wav$/.test(name))
        .sort();
      while (chunks.length > this.maxChunks) {
        const oldest = chunks.shift();
        if (oldest) rmSync(join(outDir, oldest), { force: true });
      }
    } catch {
      // pruning is best-effort
    }
  }
}
