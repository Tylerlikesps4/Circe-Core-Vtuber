/**
 * Zero-dependency voice activity detection over 16-bit PCM WAV files: parse
 * the RIFF container, window the samples, and decide whether any window
 * carries real speech energy. No native bindings — just byte math.
 */

export interface VadOptions {
  /** RMS threshold above which a window counts as speech (default 0.01). */
  threshold?: number;
  /** Analysis window length in ms (default 30). */
  windowMs?: number;
}

export interface VadResult {
  speech: boolean;
  /** Highest window RMS found, on a 0..1 scale. */
  peak: number;
}

export interface ParsedWav {
  sampleRate: number;
  /** 16-bit PCM samples (-32768..32767). */
  samples: Int16Array;
}

/** Parse a RIFF/WAVE file into its PCM samples; null for anything else. */
export function parseWav(data: Uint8Array): ParsedWav | null {
  if (data.byteLength < 44) return null;
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const view = new DataView(buffer);
  const ascii = (offset: number, len: number): string => {
    const bytes = new Uint8Array(buffer, offset, len);
    return String.fromCharCode(...bytes);
  };
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") return null;

  let offset = 12;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let channels = 0;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataStart = body;
      dataLength = size;
      break;
    }
    offset = body + size + (size % 2);
  }

  if (dataStart < 0 || sampleRate <= 0 || bitsPerSample !== 16 || channels < 1) return null;
  const sampleCount = Math.floor(dataLength / 2);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = view.getInt16(dataStart + i * 2, true);
  }
  return { sampleRate, samples };
}

/** Root-mean-square energy of a sample window, on a 0..1 scale. */
export function rms(samples: Int16Array, start: number, end: number): number {
  const length = Math.min(end, samples.length) - start;
  if (length <= 0) return 0;
  let sum = 0;
  for (let i = start; i < start + length; i++) {
    const s = samples[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / length);
}

/**
 * Decide whether a WAV buffer contains speech: slide a fixed-size window over
 * the samples and stop at the first window whose RMS clears the threshold.
 */
export function detectSpeech(data: Uint8Array, options: VadOptions = {}): VadResult {
  const parsed = parseWav(data);
  if (!parsed || parsed.samples.length === 0) return { speech: false, peak: 0 };
  const threshold = options.threshold ?? 0.01;
  const windowSize = Math.max(1, Math.floor((parsed.sampleRate * (options.windowMs ?? 30)) / 1000));
  let peak = 0;
  for (let start = 0; start < parsed.samples.length; start += windowSize) {
    const value = rms(parsed.samples, start, start + windowSize);
    if (value > peak) peak = value;
    if (value > threshold) return { speech: true, peak: value };
  }
  return { speech: false, peak };
}

/** Build a 16-bit mono PCM WAV buffer (tests and capture stubs). */
export function buildWav(samples: number[] | Int16Array, sampleRate = 16000): Buffer {
  const count = samples.length;
  const buffer = Buffer.alloc(44 + count * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + count * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) buffer.writeInt16LE(samples[i], 44 + i * 2);
  return buffer;
}
