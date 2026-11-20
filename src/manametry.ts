import { execFile } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";

export interface ManaPoolOptions {
  /** Probe the GPU with nvidia-smi; disable on non-NVIDIA hosts. */
  gpu?: boolean;
  /** Path to the nvidia-smi binary. */
  nvidiaSmi?: string;
  /** Seconds between GPU probes (nvidia-smi is slow to spawn). */
  gpuCacheMs?: number;
}

export interface CpuSample {
  /** Instantaneous busy ratio across all cores, 0..1. */
  load: number;
  cores: number;
}

export interface MemorySample {
  used: number;
  total: number;
}

export interface GpuSample {
  name: string;
  usedMB: number;
  totalMB: number;
  /** Utilization percent, 0..100. */
  util: number;
}

export interface ContextSample {
  used: number;
  total: number;
}

export interface ManaSnapshot {
  ts: number;
  cpu: CpuSample;
  memory: MemorySample;
  gpu: GpuSample | null;
  context: ContextSample | null;
}

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Circe's "cyber-sorcery" meter. Samples the host (CPU, RAM, NVIDIA GPU) and
 * holds the AI session's token usage (fed from the harness via
 * `POST /metrics`), then renders it all in-character:
 *
 *   context window  -> "memory pool"
 *   weights         -> "spell lattice" (CPU load)
 *   VRAM            -> "mana reserves"
 */
export class ManaPool {
  private context: ContextSample | null = null;
  private gpuCache: { sample: GpuSample | null; at: number } | null = null;
  private readonly options: Required<Pick<ManaPoolOptions, "gpu" | "nvidiaSmi" | "gpuCacheMs">>;

  constructor(options: ManaPoolOptions = {}) {
    this.options = {
      gpu: options.gpu ?? true,
      nvidiaSmi: options.nvidiaSmi ?? "nvidia-smi",
      gpuCacheMs: options.gpuCacheMs ?? 5000,
    };
  }

  setContext(used: number, total: number): void {
    if (!Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total < 0) return;
    this.context = { used, total };
  }

  async snapshot(): Promise<ManaSnapshot> {
    return {
      ts: Date.now(),
      cpu: this.sampleCpu(),
      memory: { used: totalmem() - freemem(), total: totalmem() },
      gpu: this.options.gpu ? await this.sampleGpu() : null,
      context: this.context,
    };
  }

  /** Render a snapshot as a short, TTS-friendly in-character block. */
  render(snapshot?: ManaSnapshot): string {
    const snap = snapshot ?? this.renderSnapshotFallback();
    const lines: string[] = ["[CYBER-SORCERY]"];
    if (snap.context) {
      lines.push(
        `Memory pool: ${Math.round(snap.context.used)}/${Math.round(snap.context.total)} tokens — ${this.percent(snap.context.used, snap.context.total)}% full.`,
      );
    } else {
      lines.push("Memory pool: unattuned (no token metrics fed yet).");
    }
    lines.push(
      `Spell lattice: ${Math.round(snap.cpu.load * 100)}% load across ${snap.cpu.cores} cores.`,
    );
    if (snap.gpu) {
      const gb = (mb: number) => (mb / 1024).toFixed(1);
      lines.push(
        `Mana reserves: ${gb(snap.gpu.usedMB)}/${gb(snap.gpu.totalMB)} GB on ${snap.gpu.name}, ${snap.gpu.util}% draw.`,
      );
    } else {
      lines.push("Mana reserves: no NVIDIA crystal found — running on system spirits alone.");
    }
    lines.push(
      `System spirits: ${this.gib(snap.memory.used)}/${this.gib(snap.memory.total)} GB.`,
    );
    return lines.join("\n");
  }

  private percent(part: number, whole: number): string {
    if (whole <= 0) return "0";
    return String(Math.min(100, Math.round((part / whole) * 100)));
  }

  private gib(bytes: number): string {
    return (bytes / 1024 ** 3).toFixed(1);
  }

  private renderSnapshotFallback(): ManaSnapshot {
    return {
      ts: Date.now(),
      cpu: this.sampleCpu(),
      memory: { used: totalmem() - freemem(), total: totalmem() },
      gpu: null,
      context: this.context,
    };
  }

  private sampleCpu(): CpuSample {
    const times = cpus().map((core) => core.times);
    const totals = times.map((t) => t.user + t.nice + t.sys + t.idle + t.irq);
    const busy = totals.map((total, i) => total - times[i].idle);
    const load = totals.reduce((acc, total, i) => acc + (total > 0 ? busy[i] / total : 0), 0);
    return { load: times.length > 0 ? load / times.length : 0, cores: times.length };
  }

  private async sampleGpu(): Promise<GpuSample | null> {
    const now = Date.now();
    if (this.gpuCache && now - this.gpuCache.at < this.options.gpuCacheMs) {
      return this.gpuCache.sample;
    }
    let sample: GpuSample | null = null;
    try {
      const output = await execFileAsync(this.options.nvidiaSmi, [
        "--query-gpu=name,memory.used,memory.total,utilization.gpu",
        "--format=csv,noheader,nounits",
      ]);
      const fields = output.trim().split("\n")[0]?.split(",").map((f) => f.trim());
      if (fields && fields.length >= 4) {
        sample = {
          name: fields[0],
          usedMB: Number(fields[1]) || 0,
          totalMB: Number(fields[2]) || 0,
          util: Number(fields[3]) || 0,
        };
      }
    } catch {
      sample = null;
    }
    this.gpuCache = { sample, at: now };
    return sample;
  }
}
