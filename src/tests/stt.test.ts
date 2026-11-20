import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribe } from "../stt.js";
import { buildWav } from "../vad.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("transcribe http sends a multipart request and returns the text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-stt-"));
  const file = join(dir, "audio.wav");
  try {
    writeFileSync(file, buildWav(new Int16Array(1600)));
    const calls: { url: string; init?: RequestInit }[] = [];
    const result = await transcribe(file, {
      backend: "http",
      httpUrl: "http://stt/v1/audio/transcriptions",
      model: "whisper-1",
      language: "en",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ text: "hello master" });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.text, "hello master");
    assert.equal(result.backend, "http");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://stt/v1/audio/transcriptions");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.match(headers["content-type"], /multipart\/form-data; boundary=/);
    const body = new Uint8Array((calls[0].init?.body as Uint8Array) ?? []);
    const text = Buffer.from(body).toString("latin1");
    assert.ok(text.includes('name="model"'), "multipart carries the model field");
    assert.ok(text.includes('name="file"; filename="audio.wav"'), "multipart carries the file field");
    assert.ok(text.includes('name="language"'), "multipart carries the language field");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcribe http reports endpoint failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-stt-"));
  const file = join(dir, "audio.wav");
  try {
    writeFileSync(file, buildWav(new Int16Array(1600)));
    const missing = await transcribe(file, { backend: "http" });
    assert.equal(missing.ok, false);
    assert.match(missing.detail ?? "", /httpUrl/);

    const serverError = await transcribe(file, {
      backend: "http",
      httpUrl: "http://stt/",
      fetchImpl: async () => new Response("boom", { status: 502 }),
    });
    assert.equal(serverError.ok, false);
    assert.match(serverError.detail ?? "", /HTTP 502/);

    const empty = await transcribe(file, {
      backend: "http",
      httpUrl: "http://stt/",
      fetchImpl: async () => jsonResponse({ text: "   " }),
    });
    assert.equal(empty.ok, false);
    assert.match(empty.detail ?? "", /empty text/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcribe command runs a binary and reads stdout as the transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-stt-"));
  const file = join(dir, "audio.wav");
  try {
    writeFileSync(file, buildWav(new Int16Array(1600)));
    const seen: string[][] = [];
    const result = await transcribe(file, {
      backend: "command",
      command: "whisper-cli",
      commandArgs: (f) => ["-m", "tiny", "-f", f],
      runImpl: async (_cmd, args) => {
        seen.push(args);
        return { ok: true, text: "hello from the cli" };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.text, "hello from the cli");
    assert.deepEqual(seen[0], ["-m", "tiny", "-f", file]);

    const failed = await transcribe(file, {
      backend: "command",
      command: "whisper-cli",
      runImpl: async () => ({ ok: false, text: "", detail: "exit 1" }),
    });
    assert.equal(failed.ok, false);
    assert.match(failed.detail ?? "", /exit 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcribe none is a no-op and unknown backends fail cleanly", async () => {
  assert.deepEqual(await transcribe("whatever.wav"), {
    ok: true,
    text: "",
    backend: "none",
    detail: "stt disabled",
  });
  const unknown = await transcribe("whatever.wav", { backend: "wizard" as never });
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail ?? "", /unknown backend/);
});
