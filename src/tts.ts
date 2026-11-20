import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runProcess, ProcResult } from "./proc.js";
import { playAudioFile } from "./playback.js";

export type TtsBackend = "none" | "espeak" | "edge-tts" | "piper" | "http";

export interface TtsOptions {
  backend?: TtsBackend;
  /** Voice name passed to the selected backend (model id for piper). */
  voice?: string;
  /** Required for the `http` backend: a URL that accepts `{"text": "..."}`. */
  httpUrl?: string;
  /** Play generated audio through the host speakers once synthesis finishes. */
  play?: boolean;
  /** Directory for synthesized audio files (created on demand). */
  outDir?: string;
  /** Always write an audio file (espeak included) and never play it. Used by the /tts gateway. */
  fileOnly?: boolean;
  /** Override the output file base name (without extension). */
  fileBase?: string;
}

export interface TtsResult {
  ok: boolean;
  backend: string;
  text: string;
  detail?: string;
  played?: boolean;
  /** Audio file written by a file backend (espeak/edge-tts/piper), if any. */
  file?: string;
}

async function speakHttp(url: string, text: string): Promise<ProcResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return { ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

function ensureOutDir(outDir: string): void {
  try {
    mkdirSync(outDir, { recursive: true });
  } catch {
    // synthesis still proceeds; file backends will report their own failure
  }
}

/**
 * Speak `text` through the configured backend. Defaults to "none", which is a
 * no-op that always succeeds so the runtime runs out of the box; wire a real
 * backend by setting `backend` and the matching voice/model or URL. With
 * `play: true`, file-writing backends (espeak/edge-tts/piper) play the
 * synthesized audio through the host speakers afterwards.
 */
export async function speak(text: string, options: TtsOptions = {}): Promise<TtsResult> {
  const backend = options.backend ?? "none";
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, backend, text, detail: "empty" };

  const fileOnly = options.fileOnly ?? false;
  const play = fileOnly ? false : options.play ?? false;
  const base = (name: string) => options.fileBase ?? name;
  const outDir = options.outDir ?? "media";
  let result: ProcResult;
  let audioFile: string | null = null;

  switch (backend) {
    case "none":
      result = { ok: true };
      break;
    case "espeak": {
      if (play || fileOnly) {
        ensureOutDir(outDir);
        audioFile = join(outDir, `${base("circe-espeak")}.wav`);
        result = await runProcess("espeak-ng", [
          "-v",
          options.voice ?? "en-us",
          "-w",
          audioFile,
          trimmed,
        ]);
      } else {
        result = await runProcess("espeak-ng", ["-v", options.voice ?? "en-us", trimmed]);
      }
      break;
    }
    case "edge-tts":
      ensureOutDir(outDir);
      audioFile = join(outDir, `${base("circe-edge")}.mp3`);
      result = await runProcess("edge-tts", [
        "--voice",
        options.voice ?? "en-US-AriaNeural",
        "--text",
        trimmed,
        "--write-media",
        audioFile,
      ]);
      break;
    case "piper":
      ensureOutDir(outDir);
      audioFile = join(outDir, `${base("circe-piper")}.wav`);
      result = await runProcess(
        "piper",
        ["--model", options.voice ?? "en_US-lessac-medium", "--output_file", audioFile],
        trimmed,
      );
      break;
    case "http":
      if (!options.httpUrl) {
        return { ok: false, backend, text, detail: "http backend requires httpUrl" };
      }
      result = await speakHttp(options.httpUrl, trimmed);
      break;
    default:
      return { ok: false, backend, text, detail: `unknown backend: ${backend}` };
  }

  let played: boolean | undefined;
  if (play && audioFile && result.ok) {
    const playback = await playAudioFile(audioFile);
    played = playback.ok;
    if (!playback.ok && !result.detail) result.detail = playback.detail;
  }

  return { ok: result.ok, backend, text, detail: result.detail, played, file: audioFile ?? undefined };
}

/** Content-type for a synthesized audio file, by extension. */
export function audioContentType(file: string): string {
  const f = file.toLowerCase();
  if (f.endsWith(".mp3")) return "audio/mpeg";
  if (f.endsWith(".ogg")) return "audio/ogg";
  return "audio/wav";
}
