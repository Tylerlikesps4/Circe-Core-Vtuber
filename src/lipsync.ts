import { readFileSync } from "node:fs";

export interface WordSegment {
  word: string;
  startMs: number;
  endMs: number;
}

export interface LipTimeline {
  segments: WordSegment[];
  durationMs: number;
}

const DEFAULT_WPM = 155;

export function msPerWord(wpm: number = DEFAULT_WPM): number {
  return 60_000 / wpm;
}

/**
 * Estimate how long `text` takes to speak at the given rate. Used to drive
 * mouth animation before (or without) real audio duration.
 */
export function estimateSpeechMs(text: string, wpm: number = DEFAULT_WPM): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return Math.round(words.length * msPerWord(wpm));
}

/**
 * Build a per-word lip-sync timeline: each word gets a start/end offset into
 * the estimated speech track so a VTuber mouth layer can animate to it.
 */
export function buildTimeline(text: string, wpm: number = DEFAULT_WPM): LipTimeline {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const per = msPerWord(wpm);
  const segments = words.map((word, i) => ({
    word,
    startMs: Math.round(i * per),
    endMs: Math.round((i + 1) * per),
  }));
  return { segments, durationMs: Math.round(words.length * per) };
}

/**
 * Read a .wav file's playback duration in ms straight from its RIFF header —
 * no audio libraries required.
 */
export function wavDurationMs(file: string): number | null {
  try {
    const data = readFileSync(file);
    if (data.length < 44 || data.toString("ascii", 0, 4) !== "RIFF") return null;
    if (data.toString("ascii", 8, 12) !== "WAVE") return null;

    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (offset + 8 <= data.length) {
      const chunkId = data.toString("ascii", offset, offset + 4);
      const chunkSize = data.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (chunkId === "fmt " && body + 12 <= data.length) {
        byteRate = data.readUInt32LE(body + 8);
      } else if (chunkId === "data") {
        dataSize = chunkSize;
      }
      offset = body + chunkSize + (chunkSize % 2);
    }
    if (byteRate <= 0 || dataSize <= 0) return null;
    return Math.round((dataSize / byteRate) * 1000);
  } catch {
    return null;
  }
}
