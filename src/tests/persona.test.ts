import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CirceBrain } from "../brain.js";
import { CirceRuntime } from "../runtime.js";
import { DEFAULT_PERSONA, EvilNeuro, getPersona, listPersonaIds, resolvePersona } from "../persona.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface CapturedBody {
  model: string;
  messages: { role: string; content: string }[];
}

test("persona registry resolves built-ins and defaults", () => {
  assert.equal(getPersona("evil-neuro")?.id, "evil-neuro");
  assert.equal(getPersona("evil-neuro")?.name, "Evil Neuro");
  assert.equal(getPersona("circe")?.id, "circe");
  assert.equal(getPersona(undefined), undefined);
  assert.equal(getPersona(null), undefined);
  assert.equal(getPersona("missing"), undefined);
  assert.deepEqual(listPersonaIds().sort(), ["circe", "evil-neuro"]);
  assert.equal(resolvePersona("evil-neuro").id, "evil-neuro");
  assert.equal(resolvePersona(undefined).id, "circe");
  assert.equal(DEFAULT_PERSONA.id, "circe");
});

test("brain runs the persona system prompt when one is set", async () => {
  const bodies: CapturedBody[] = [];
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    persona: EvilNeuro,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as CapturedBody;
      bodies.push(body);
      return jsonResponse({ choices: [{ message: { content: "Oh, you know I like it." } }] });
    },
  });

  const answer = await brain.reply("hello, Master");
  assert.equal(answer, "Oh, you know I like it.");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, "m");
  assert.match(bodies[0].messages[0].content, /Evil Neuro/);
  assert.match(bodies[0].messages[0].content, /twin sister/);
  assert.equal(brain.persona()?.id, "evil-neuro");
});

test("brain persona llm overrides model and endpoint", async () => {
  const seen: { url: string; model: string }[] = [];
  const brain = new CirceBrain({
    baseUrl: "http://default/v1",
    model: "default-model",
    persona: { ...EvilNeuro, llm: { baseUrl: "http://evil/v1", model: "evil-model" } },
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), model: String((JSON.parse(String(init?.body)) as { model: string }).model) });
      return jsonResponse({ choices: [{ message: { content: "Ha." } }] });
    },
  });

  assert.equal(await brain.reply("hello"), "Ha.");
  assert.deepEqual(seen, [{ url: "http://evil/v1/chat/completions", model: "evil-model" }]);
});

test("brain setPersona swaps the prompt and llm mid-flight", async () => {
  const bodies: CapturedBody[] = [];
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    persona: EvilNeuro,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as CapturedBody;
      bodies.push(body);
      return jsonResponse({ choices: [{ message: { content: "Betrayal tastes sweet." } }] });
    },
  });

  await brain.reply("hello");
  assert.match(bodies[0].messages[0].content, /Evil Neuro/);
  assert.equal(bodies[0].model, "m");

  brain.setPersona({ ...DEFAULT_PERSONA, systemPrompt: "You are the betrayed sister now." });
  await brain.reply("hello again");
  assert.match(bodies[1].messages[0].content, /betrayed sister/);
  assert.equal(bodies[1].model, "m");
  assert.equal(brain.persona()?.id, "circe");
});

test("runtime runs a persona end to end through the brain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-persona-"));
  const bodies: CapturedBody[] = [];
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    persona: EvilNeuro,
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as CapturedBody;
        bodies.push(body);
        return jsonResponse({ choices: [{ message: { content: "*smirks* Oh, Master~" } }] });
      },
    },
    tts: { backend: "none" },
  });
  try {
    runtime.stream.pushChat("alice", "hello");
    const result = await runtime.chat("what are you plotting?");

    assert.equal(result.answer, "*smirks* Oh, Master~");
    assert.equal(runtime.persona()?.id, "evil-neuro");
    const last = bodies[bodies.length - 1];
    assert.ok(last);
    assert.match(String(last.messages[0].content), /Evil Neuro/);
    assert.ok(last.messages[0].content.includes("You are Evil Neuro"));
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brain reply accepts a per-call persona override", async () => {
  const bodies: CapturedBody[] = [];
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as CapturedBody;
      bodies.push(body);
      return jsonResponse({ choices: [{ message: { content: "Override me." } }] });
    },
  });

  assert.equal(await brain.reply("hello", "", { persona: EvilNeuro }), "Override me.");
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].messages[0].content, /Evil Neuro/);
});

test("runtime applies per-viewer personas for the viewer chat turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-persona-"));
  const bodies: CapturedBody[] = [];
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    viewerPersonas: { alice: EvilNeuro },
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as CapturedBody;
        bodies.push(body);
        return jsonResponse({ choices: [{ message: { content: "Hello there." } }] });
      },
    },
    tts: { backend: "none" },
  });
  try {
    await runtime.chat("hello", {}, "alice");
    let last = bodies[bodies.length - 1];
    assert.ok(last);
    assert.match(String(last.messages[0].content), /You are Evil Neuro/);

    await runtime.chat("hello", {}, "bob");
    last = bodies[bodies.length - 1];
    assert.ok(last);
    assert.match(String(last.messages[0].content), /You are Circe-Core/);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime defaults to the Circe persona and can swap personas", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-persona-"));
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
  });
  try {
    assert.equal(runtime.persona()?.id, "circe");
    assert.equal(runtime.persona()?.name, "Circe");

    runtime.setPersona(EvilNeuro);
    assert.equal(runtime.persona()?.id, "evil-neuro");
    assert.equal(runtime.brain, null, "no brain is wired without one configured");
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
