import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CirceBrain, LlmMessage } from "../brain.js";
import { CirceRuntime } from "../runtime.js";
import { DEFAULT_PERSONA, EvilNeuro } from "../persona.js";
import { clampLine, runDuet } from "../duet.js";
import type { DuetLine } from "../duet.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("clampLine trims quotes and cuts at a sentence boundary", () => {
  assert.equal(clampLine('"Hello there."'), "Hello there.");
  const long = "First sentence stays. " + "x".repeat(200);
  assert.equal(clampLine(long, 60), "First sentence stays.");
  const noBoundary = "y".repeat(100);
  assert.ok(clampLine(noBoundary, 40).endsWith("…"));
  assert.equal(clampLine("  short  "), "short");
});

test("runDuet alternates personas against a shared attributed transcript", async () => {
  const seen: string[][] = [];
  const brain = {
    execute: async (messages: LlmMessage[]) => {
      const system = String(messages[0].content);
      const user = String(messages[1].content);
      seen.push([system, user]);
      if (system.startsWith("You are Evil Neuro")) return "*smirks* You called, sister?";
      return "*pours tea* I did. Try to behave.";
    },
  };

  const lines: DuetLine[] = [];
  const result = await runDuet(
    brain,
    { primary: DEFAULT_PERSONA, partner: EvilNeuro },
    "a midnight tea party",
    { turns: 4, onLine: (line) => {
      lines.push(line);
    } },
  );

  assert.equal(result.lines.length, 4);
  assert.deepEqual(
    result.lines.map((line) => line.speaker),
    ["Circe", "Evil Neuro", "Circe", "Evil Neuro"],
  );
  assert.deepEqual(
    result.lines.map((line) => line.personaId),
    ["circe", "evil-neuro", "circe", "evil-neuro"],
  );
  assert.equal(lines.length, 4, "onLine fires per line");
  assert.equal(result.error, undefined);

  assert.match(seen[0][0], /\[DUET\]/);
  assert.match(seen[0][1], /Open the bit/);
  assert.match(seen[0][1], /midnight tea party/);
  assert.match(seen[1][0], /Evil Neuro/);
  assert.match(seen[1][1], /Circe: \*pours tea\* I did\. Try to behave\./);
  assert.match(seen[3][1], /Evil Neuro: \*smirks\* You called, sister\?/);
});

test("runDuet can open with the partner and stop cleanly on failure", async () => {
  const partnerFirst = await runDuet(
    {
      execute: async (messages) => (String(messages[0].content).startsWith("You are Evil Neuro") ? "evil opener" : "circe answer"),
    },
    { primary: DEFAULT_PERSONA, partner: EvilNeuro },
    "trouble",
    { turns: 2, opener: "partner" },
  );
  assert.deepEqual(
    partnerFirst.lines.map((line) => line.personaId),
    ["evil-neuro", "circe"],
  );

  let calls = 0;
  const failed = await runDuet(
    {
      execute: async () => {
        calls += 1;
        throw new Error("endpoint down");
      },
    },
    { primary: DEFAULT_PERSONA, partner: EvilNeuro },
    "anything",
    { turns: 4 },
  );
  assert.equal(calls, 1, "stops after the first failed turn");
  assert.equal(failed.lines.length, 1);
  assert.equal(failed.lines[0].personaId, "circe");
  assert.match(failed.lines[0].text, /microphone/);
  assert.match(failed.error ?? "", /endpoint down/);
});

test("runDuet keeps empty replies out of the transcript", async () => {
  let calls = 0;
  const result = await runDuet(
    {
      execute: async () => {
        calls += 1;
        return calls === 1 ? "   " : "second line";
      },
    },
    { primary: DEFAULT_PERSONA, partner: EvilNeuro },
    "silence",
    { turns: 3 },
  );
  assert.equal(calls, 1);
  assert.match(result.error ?? "", /empty reply/);
  assert.match(result.lines[0].text, /break the model/);
});

test("runtime.duet speaks each line and leaves the talker history untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-duet-"));
  const bodies: LlmMessage[][] = [];
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      fetchImpl: async (_url, init) => {
        const parsed = JSON.parse(String(init?.body)) as { messages: LlmMessage[] };
        bodies.push(parsed.messages);
        const evil = String(parsed.messages[0].content).startsWith("You are Evil Neuro");
        return jsonResponse({
          choices: [{ message: { content: evil ? "*cackles* Predictable." : "*sips* As always." } }],
        });
      },
    },
  });

  const events: Record<string, unknown>[] = [];
  runtime.bus.on((event) => events.push(event));
  try {
    const result = await runtime.duet("who is the better witch?", { partner: EvilNeuro, turns: 2 });
    assert.equal(result.lines.length, 2);
    assert.equal(result.lines[0].speaker, "Circe");
    assert.equal(result.lines[1].speaker, "Evil Neuro");

    assert.equal(bodies.length, 2);
    assert.match(String(bodies[0][0].content), /You are Circe-Core/);
    assert.match(String(bodies[1][0].content), /You are Evil Neuro/);

    const speech = events.filter((event) => event.type === "speech");
    assert.deepEqual(
      speech.map((event) => event.text),
      ["As always.", "Predictable."],
      "spoken text drops the *asterisk* cues",
    );
    assert.equal(events.filter((event) => event.type === "duet-turn").length, 2);
    assert.equal(runtime.brain?.turns().length, 0, "duet completions bypass the talker history");

    await runtime.start();
    const res = await fetch(`http://127.0.0.1:${runtime.stream.port}/duet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "midnight tea", partner: "evil-neuro", turns: 2 }),
    });
    const body = (await res.json()) as { ok: boolean; result?: { lines: DuetLine[] } };
    assert.equal(body.ok, true);
    assert.equal(body.result?.lines.length, 2);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime.duet requires the brain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-duet-"));
  const runtime = new CirceRuntime({ port: 0, logFile: join(dir, "events.jsonl") });
  try {
    await assert.rejects(
      () => runtime.duet("nobody home", { partner: EvilNeuro, turns: 2 }),
      /brain/,
    );
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CirceBrain is a valid duet brain", () => {
  const brain: CirceBrain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
  });
  assert.equal(typeof brain.execute, "function");
});
