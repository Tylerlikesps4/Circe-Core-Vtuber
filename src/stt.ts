import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

export type SttBackend = "none" | "http" | "command";

/** A stdout-capturing run: `text` carries the transcript for the command backend. */
export interface SttRunResult {
  ok: boolean;
  text: string;
  detail?: string;
}

export interface SttOptions {
  backend?: SttBackend;
  /** `http` backend: an OpenAI-compatible /audio/transcriptions URL. */
  httpUrl?: string;
  /** Model name sent to the transcription endpoint (default "whisper-1"). */
  model?: string;
  /** Optional bearer token for the transcription endpoint. */
  apiKey?: string;
  /** Optional language hint (multipart `language` field). */
  language?: string;
  /** `command` backend: a local speech-to-text binary (e.g. whisper-cli). */
  command?: string;
  /** `command` backend: args builder for the audio file (defaults to the file). */
  commandArgs?: (file: string) => string[];
  /** Test hook: inject the command-backend runner. */
  runImpl?: (cmd: string, args: string[]) => Promise<SttRunResult>;
  /** Test hook: inject a fetch implementation. */
  fetchImpl?: typeof fetch;
}

export interface SttResult {
  ok: boolean;
  text: string;
  backend: string;
  detail?: string;
}

/** Spawn a command and capture its stdout as the transcript. */
function runCapturing(cmd: string, args: string[]): Promise<SttRunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => resolve({ ok: false, text: "", detail: err.message }));
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        text: stdout.trim(),
        detail: code === 0 ? undefined : stderr.trim() || `exit ${code}`,
      });
    });
  });
}

/** Build a multipart/form-data body for a transcription request. */
function multipartBody(
  model: string,
  filename: string,
  wav: Buffer,
  language?: string,
): { body: Uint8Array<ArrayBuffer>; headers: Record<string, string> } {
  const boundary = `----circe-stt-${Date.now()}`;
  const parts: Buffer[] = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`),
  ];
  if (language) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`,
    ),
  );
  parts.push(wav);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const combined = Buffer.concat(parts);
  const body = new Uint8Array(combined.byteLength);
  body.set(combined);
  return {
    body,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function transcribeHttp(
  file: string,
  options: SttOptions,
): Promise<SttResult> {
  if (!options.httpUrl) {
    return { ok: false, text: "", backend: "http", detail: "http backend requires httpUrl" };
  }
  let wav: Buffer;
  try {
    wav = readFileSync(file);
  } catch (err) {
    return {
      ok: false,
      text: "",
      backend: "http",
      detail: `cannot read audio: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const model = options.model ?? "whisper-1";
  const multipart = multipartBody(model, file.split(/[\\/]/).pop() ?? "audio.wav", wav, options.language);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchImpl(options.httpUrl, {
      method: "POST",
      headers: {
        ...multipart.headers,
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: multipart.body,
    });
    if (!res.ok) return { ok: false, text: "", backend: "http", detail: `HTTP ${res.status}` };
    const data = (await res.json()) as { text?: string };
    const text = data.text?.trim() ?? "";
    if (!text) return { ok: false, text: "", backend: "http", detail: "endpoint returned empty text" };
    return { ok: true, text, backend: "http" };
  } catch (err) {
    return {
      ok: false,
      text: "",
      backend: "http",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function transcribeCommand(
  file: string,
  options: SttOptions,
): Promise<SttResult> {
  if (!options.command) {
    return { ok: false, text: "", backend: "command", detail: "command backend requires command" };
  }
  const run = options.runImpl ?? runCapturing;
  const args = options.commandArgs ? options.commandArgs(file) : [file];
  const result = await run(options.command, args);
  if (!result.ok) {
    return { ok: false, text: "", backend: "command", detail: result.detail };
  }
  const text = result.text.trim();
  if (!text) {
    return { ok: false, text: "", backend: "command", detail: "no transcript on stdout" };
  }
  return { ok: true, text, backend: "command" };
}

/**
 * Turn an audio file into text through one of the pluggable backends:
 * `none` (no-op), `http` (OpenAI-compatible /audio/transcriptions endpoint,
 * multipart form), or `command` (a local binary such as whisper-cli whose
 * stdout is the transcript).
 */
export async function transcribe(file: string, options: SttOptions = {}): Promise<SttResult> {
  const backend = options.backend ?? "none";
  if (backend === "http") return transcribeHttp(file, options);
  if (backend === "command") return transcribeCommand(file, options);
  if (backend === "none") return { ok: true, text: "", backend, detail: "stt disabled" };
  return { ok: false, text: "", backend, detail: `unknown backend: ${backend}` };
}
