import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runProcess, ProcResult } from "./proc.js";
import type { EventBus } from "./bus.js";

export interface VisionOptions {
  /** ffmpeg binary (default "ffmpeg"). */
  command?: string;
  /**
   * Input device for a single-frame grab. Platform defaults:
   * Windows `video=OBS Virtual Camera`, macOS `0:none`, Linux `/dev/video0`.
   */
  input?: string;
  /** Directory for captured frames (default "media/frames"). */
  outDir?: string;
  /** Polling interval while started, in ms (default 15000). */
  intervalMs?: number;
  /** JPEG quality for ffmpeg's -q:v, 2-31 where lower is better (default 3). */
  quality?: number;
  /** Keep at most this many frames on disk (default 8). */
  maxFrames?: number;
  /** Test hook: inject the process runner. */
  runImpl?: (cmd: string, args: string[]) => Promise<ProcResult>;
}

export interface VisionFrame {
  file: string;
  ts: number;
  ok: boolean;
  detail?: string;
}

/**
 * Build the ffmpeg command that grabs one still frame from the camera input
 * into `outFile` as a JPEG.
 */
export function frameCommand(
  platform: NodeJS.Platform,
  input: string | undefined,
  outFile: string,
  quality: number,
  command = "ffmpeg",
): { cmd: string; args: string[] } {
  const q = String(quality);
  if (platform === "win32") {
    return {
      cmd: command,
      args: [
        "-y",
        "-f",
        "dshow",
        "-i",
        input ?? "video=OBS Virtual Camera",
        "-frames:v",
        "1",
        "-q:v",
        q,
        outFile,
      ],
    };
  }
  if (platform === "darwin") {
    return {
      cmd: command,
      args: ["-y", "-f", "avfoundation", "-i", input ?? "0:none", "-frames:v", "1", "-q:v", q, outFile],
    };
  }
  return {
    cmd: command,
    args: ["-y", "-f", "v4l2", "-i", input ?? "/dev/video0", "-frames:v", "1", "-q:v", q, outFile],
  };
}

export interface LlmImagePart {
  type: "image_url";
  image_url: { url: string };
}

/**
 * Grabs still frames from the stream (OBS virtual camera, webcam, or any
 * ffmpeg-readable input) so vision-capable brains can see the scene. Frames
 * land as JPEGs in `outDir`, are pruned to `maxFrames`, and can be turned
 * into an OpenAI-compatible `image_url` part for multimodal prompts.
 */
export class VisionSampler {
  private latestFrame: VisionFrame | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly run: (cmd: string, args: string[]) => Promise<ProcResult>;
  private readonly quality: number;
  private readonly intervalMs: number;
  private readonly maxFrames: number;

  constructor(
    private readonly options: VisionOptions = {},
    private readonly bus: EventBus | null = null,
  ) {
    this.run = options.runImpl ?? runProcess;
    this.quality = Math.max(2, Math.min(31, options.quality ?? 3));
    this.intervalMs = Math.max(1000, options.intervalMs ?? 15_000);
    this.maxFrames = Math.max(1, options.maxFrames ?? 8);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Most recent successful frame, if any. */
  latest(): VisionFrame | null {
    return this.latestFrame;
  }

  /** Grab one frame from the camera input. */
  async capture(): Promise<VisionFrame> {
    const outDir = this.options.outDir ?? join("media", "frames");
    const ts = Date.now();
    const file = join(outDir, `frame-${ts}.jpg`);
    try {
      mkdirSync(outDir, { recursive: true });
    } catch {
      // the runner will report its own failure if the directory is unusable
    }
    const { cmd, args } = frameCommand(
      process.platform,
      this.options.input,
      file,
      this.quality,
      this.options.command,
    );
    const result = await this.run(cmd, args);
    const ok = result.ok && existsSync(file);
    const frame: VisionFrame = { file, ts, ok, detail: result.detail };
    if (ok) {
      this.latestFrame = frame;
      this.prune(outDir);
      this.bus?.emit("vision-frame", { file, ts });
    }
    return frame;
  }

  /** Start periodic frame grabs (no-op if already running). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.capture();
    }, this.intervalMs);
    this.timer.unref?.();
    void this.capture();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * The latest frame as an OpenAI-compatible image part (base64 data URI),
   * or null when no frame has been captured yet.
   */
  framePart(): LlmImagePart | null {
    const frame = this.latestFrame;
    if (!frame?.ok) return null;
    try {
      const data = readFileSync(frame.file);
      return {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${data.toString("base64")}` },
      };
    } catch {
      return null;
    }
  }

  private prune(outDir: string): void {
    try {
      const frames = readdirSync(outDir)
        .filter((name) => /^frame-\d+\.jpg$/.test(name))
        .sort();
      while (frames.length > this.maxFrames) {
        const oldest = frames.shift();
        if (oldest) rmSync(join(outDir, oldest), { force: true });
      }
    } catch {
      // pruning is best-effort
    }
  }
}
