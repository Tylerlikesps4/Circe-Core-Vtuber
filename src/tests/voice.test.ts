import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../bus.js";
import { CirceRuntime } from "../runtime.js";
import { VoiceLoop, captureCommand } from "../voice.js";
import { buildWav } from "../vad.js";

function toneWav(rate = 16000, seconds = 1): Buffer {
  return buildWav(
    Array.from({ length: rate * seconds }, (_, i) => Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / rate))),
    rate,
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("captureCommand builds platform-specific mic chunk grabs", () => {
  const win = captureCommand("win32", undefined, "out.wav", 4);
  assert.equal(win.cmd, "ffmpeg");
  assert.ok(win.args.includes("-f"));
  assert.ok(win.args.includes("dshow"));
  assert.ok(win.args.includes("audio=Microphone"));
  assert.ok(win.args.includes("16000"));

  const mac = captureCommand("darwin", undefined, "out.wav", 2);
  assert.ok(mac.args.includes("avfoundation"));
  assert.equal(mac.args[mac.args.indexOf("-t") + 1], "2");

  const linux = captureCommand("linux", "pulse", "out.wav", 4);
  assert.ok(linux.args.includes("alsa"));
  assert.ok(linux.args.includes("pulse"));
});

test("poll gates silence without transcribing and drops the chunk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-voice-"));
  const bus = new EventBus();
  const events: Record<string, unknown>[] = [];
  bus.on((event) => events.push(event));
  let transcribed = false;
  const loop = new VoiceLoop(
    {
      outDir: join(dir, "chunks"),
      runImpl: async (_cmd, args) => {
        writeFileSync(String(args[args.length - 1]), buildWav(new Int16Array(1600)));
        return { ok: true };
      },
      stt: {
        backend: "http",
        httpUrl: "http://stt/",
        fetchImpl: async () => {
          transcribed = true;
          return jsonResponse({ text: "never" });
        },
      },
    },
    bus,
  );
  try {
    const turn = await loop.poll();
    assert.equal(turn, null);
    assert.equal(transcribed, false, "silence never reaches the STT bridge");
    assert.equal(events.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("poll transcribes speech chunks and emits a voice-turn event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-voice-"));
  const bus = new EventBus();
  const events: Record<string, unknown>[] = [];
  bus.on((event) => events.push(event));
  const loop = new VoiceLoop(
    {
      outDir: join(dir, "chunks"),
      runImpl: async (_cmd, args) => {
        writeFileSync(String(args[args.length - 1]), toneWav());
        return { ok: true };
      },
      stt: {
        backend: "http",
        httpUrl: "http://stt/",
        fetchImpl: async () => jsonResponse({ text: "is anyone here?" }),
      },
    },
    bus,
  );
  try {
    const turn = await loop.poll();
    assert.equal(turn?.text, "is anyone here?");
    assert.equal(turn?.speaker, "Master");
    const event = events.find((e) => e.type === "voice-turn");
    assert.ok(event);
    assert.equal(event.text, "is anyone here?");
    assert.equal(typeof event.ts, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("poll skips too-short transcripts and emits voice-error on capture failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-voice-"));
  const bus = new EventBus();
  const events: Record<string, unknown>[] = [];
  bus.on((event) => events.push(event));

  const short = new VoiceLoop(
    {
      outDir: join(dir, "chunks"),
      minChars: 5,
      runImpl: async (_cmd, args) => {
        writeFileSync(String(args[args.length - 1]), toneWav());
        return { ok: true };
      },
      stt: {
        backend: "http",
        httpUrl: "http://stt/",
        fetchImpl: async () => jsonResponse({ text: "hi" }),
      },
    },
    bus,
  );
  try {
    assert.equal(await short.poll(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const broken = new VoiceLoop(
    {
      outDir: join(dir, "chunks"),
      runImpl: async () => ({ ok: false, detail: "no microphone" }),
      stt: { backend: "http", httpUrl: "http://stt/" },
    },
    bus,
  );
  try {
    assert.equal(await broken.poll(), null);
    const error = events.find((e) => e.type === "voice-error");
    assert.ok(error);
    assert.equal(error.detail, "no microphone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start polls on an interval and stop cancels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-voice-"));
  const bus = new EventBus();
  let captures = 0;
  const loop = new VoiceLoop(
    {
      outDir: join(dir, "chunks"),
      pollMs: 100,
      runImpl: async (_cmd, args) => {
        captures += 1;
        writeFileSync(String(args[args.length - 1]), buildWav(new Int16Array(1600)));
        return { ok: true };
      },
      stt: { backend: "http", httpUrl: "http://stt/" },
    },
    bus,
  );
  try {
    loop.start();
    assert.equal(loop.running, true);
    await new Promise((resolve) => setTimeout(resolve, 260));
    loop.stop();
    assert.equal(loop.running, false);
    const seen = captures;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(captures, seen, "no further polls after stop");
    assert.ok(captures >= 2, `expected a few poll cycles, got ${captures}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime folds voice turns into the stream context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-voice-"));
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    voice: {
      outDir: join(dir, "chunks"),
      runImpl: async (_cmd, args) => {
        writeFileSync(String(args[args.length - 1]), toneWav());
        return { ok: true };
      },
      stt: {
        backend: "http",
        httpUrl: "http://stt/",
        fetchImpl: async () => jsonResponse({ text: "Master, are you there?" }),
      },
    },
  });
  try {
    const turn = await runtime.voice?.poll();
    assert.equal(turn?.text, "Master, are you there?");
    const chat = runtime.stream.context().chat;
    assert.ok(
      chat.some((c) => c.user === "Master" && c.message === "Master, are you there?"),
      "the voice turn lands in the stream context as a Master line",
    );
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("poll prunes old chunks beyond maxChunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-voice-"));
  const outDir = join(dir, "chunks");
  const bus = new EventBus();
  const loop = new VoiceLoop(
    {
      outDir,
      maxChunks: 2,
      runImpl: async (_cmd, args) => {
        writeFileSync(String(args[args.length - 1]), toneWav());
        return { ok: true };
      },
      stt: {
        backend: "http",
        httpUrl: "http://stt/",
        fetchImpl: async () => jsonResponse({ text: "one more line" }),
      },
    },
    bus,
  );
  try {
    await loop.poll();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await loop.poll();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await loop.poll();
    const chunks = readdirSync(outDir).filter((name) => /^voice-\d+\.wav$/.test(name));
    assert.equal(chunks.length, 2, "only the newest chunks survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
