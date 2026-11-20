import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../bus.js";
import { VoiceChat } from "../voicechat.js";
import type { VoiceChatLine, VoiceChatOptions } from "../voicechat.js";

interface Harness {
  bus: EventBus;
  chat: VoiceChat;
  spoken: VoiceChatLine[];
  errors: Record<string, unknown>[];
  replies: Record<string, unknown>[];
}

function harness(options: VoiceChatOptions = {}): Harness {
  const bus = new EventBus();
  const spoken: VoiceChatLine[] = [];
  const errors: Record<string, unknown>[] = [];
  const replies: Record<string, unknown>[] = [];
  const chat = new VoiceChat(
    bus,
    async (line) => {
      spoken.push({ user: line.user, text: line.text, ts: Date.now() });
    },
    options,
  );
  bus.on((event) => {
    if (event.type === "voice-chat-error") errors.push(event);
    if (event.type === "voice-chat-reply") replies.push(event);
  });
  return { bus, chat, spoken, errors, replies };
}

function waitUntil(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (fn()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timeout waiting for condition"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

test("voice turns speak in order", async () => {
  const { chat, spoken } = harness({ minGapMs: 0 });
  chat.start();
  chat.onTurn("Master", "hello there, miss you");
  chat.onTurn("Master", "are you online?");
  await waitUntil(() => spoken.length === 2);
  assert.deepEqual(
    spoken.map((line) => line.text),
    ["hello there, miss you", "are you online?"],
  );
  assert.equal(chat.status.running, true);
  assert.equal(chat.status.queued, 0);
  chat.stop();
  assert.equal(chat.status.running, false);
});

test("ignored speakers never trigger replies", async () => {
  const { chat, spoken } = harness({ minGapMs: 0, ignore: (user) => user === "bot" });
  chat.start();
  chat.onTurn("BOT", "hey, someone there?");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(spoken.length, 0);
  chat.onTurn("master", "real user says hi");
  await waitUntil(() => spoken.length === 1);
  assert.equal(spoken[0].user, "master");
});

test("minGapMs spaces spoken replies", async () => {
  const { chat, spoken } = harness({ minGapMs: 60 });
  chat.start();
  chat.onTurn("Master", "first thing");
  chat.onTurn("Master", "second thing");
  await waitUntil(() => spoken.length === 2);
  const delta = spoken[1].ts - spoken[0].ts;
  assert.ok(delta >= 45, `replies should be spaced >=45ms apart, got ${delta}ms`);
});

test("speak failures emit voice-chat-error and the queue keeps moving", async () => {
  const bus = new EventBus();
  const errors: Record<string, unknown>[] = [];
  const spoken: string[] = [];
  bus.on((event) => {
    if (event.type === "voice-chat-error") errors.push(event);
  });
  const chat = new VoiceChat(
    bus,
    async (line) => {
      if (line.text === "boom") throw new Error("tts exploded");
      spoken.push(line.text);
    },
    { minGapMs: 0 },
  );
  chat.start();
  chat.onTurn("Master", "boom");
  chat.onTurn("Master", "after the crash");
  await waitUntil(() => spoken.length === 1);
  assert.equal(spoken[0], "after the crash");
  assert.equal(errors.length, 1);
  assert.match(String(errors[0].error), /tts exploded/);
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("turns queue behind an in-flight reply", async () => {
  const bus = new EventBus();
  const spoken: string[] = [];
  const slow = deferred();
  const chat = new VoiceChat(
    bus,
    async (line) => {
      if (line.text === "slow reply") {
        spoken.push(line.text);
        await slow.promise;
        return;
      }
      spoken.push(line.text);
    },
    { minGapMs: 0 },
  );
  chat.start();
  chat.onTurn("Master", "slow reply");
  await waitUntil(() => chat.isSpeaking() === true);
  assert.deepEqual(spoken, ["slow reply"]);
  chat.onTurn("Master", "queued while busy");
  assert.equal(chat.queued(), 1);
  slow.resolve();
  await waitUntil(() => spoken.length === 2);
  assert.deepEqual(spoken, ["slow reply", "queued while busy"]);
});

test("stop clears the queue and the loop", async () => {
  const { chat, spoken } = harness({ minGapMs: 0 });
  chat.onTurn("Master", "hi");
  chat.stop();
  assert.equal(chat.status.queued, 0);
  assert.equal(chat.status.running, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(spoken.length, 0);
});

test("runtime: voice-turn events speak through the pipeline and GET /voicechat", async () => {
  const { mkdtempSync, tmpdir, join } = await import("node:fs").then(
    async (m) => {
      const fs = m;
      const os = await import("node:os");
      const path = await import("node:path");
      return { mkdtempSync: fs.mkdtempSync, tmpdir: os.tmpdir, join: path.join };
    },
  );
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { CirceRuntime } = await import("../runtime.js");

  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "circe-voicechat-")), "events.jsonl");
  const runtime = new CirceRuntime({ port: 0, logFile, voiceChat: { minGapMs: 0 } });
  const spokenSpeech: string[] = [];
  runtime.bus.on((event) => {
    if (event.type === "speech") spokenSpeech.push(String(event.text));
  });

  try {
    await runtime.start();
    assert.equal(runtime.voiceChat?.status.running, true);

    const res = await fetch(`http://127.0.0.1:${runtime.stream.port}/voicechat`);
    const status = (await res.json()) as { ok: boolean; running: boolean };
    assert.equal(status.ok, true);
    assert.equal(status.running, true);

    runtime.bus.emit("voice-turn", { speaker: "Master", text: "i can see your house from here" });
    await waitUntil(() => spokenSpeech.length > 0);
    assert.match(spokenSpeech.join(" "), /see your house/);
    assert.ok(
      runtime.stream.context().chat.some((m) => m.user === "Master" && m.message.includes("see your house")),
    );

    const after = await fetch(`http://127.0.0.1:${runtime.stream.port}/voicechat`);
    const status2 = (await after.json()) as { ok: boolean; speaking: boolean };
    assert.equal(status2.ok, true);
    assert.equal(status2.speaking, false);
  } finally {
    await runtime.stop();
    runtime.voiceChat?.stop();
  }
});
