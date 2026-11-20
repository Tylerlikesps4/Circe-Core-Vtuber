import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CirceRuntime } from "../runtime.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("chat() feeds the brain with context and speaks the answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "You are Circe.",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] });
        return jsonResponse({
          choices: [{ message: { content: "*giggles* Another drop of moonlight for you, dear." } }],
        });
      },
    },
  });
  try {
    runtime.stream.pushChat("alice", "hello circe");
    const result = await runtime.chat("what is brewing?");

    assert.equal(result.answer, "*giggles* Another drop of moonlight for you, dear.");
    assert.equal(result.processed.speech, "Another drop of moonlight for you, dear.");
    assert.equal(result.processed.cues.length, 1);
    assert.equal(result.processed.cues[0].expression, "joy");

    const messages = bodies[bodies.length - 1]?.messages ?? [];
    assert.ok(messages.length >= 2);
    assert.match(messages[0].content, /STREAM CONTEXT/);
    assert.match(messages[0].content, /alice: hello circe/);
    assert.match(messages[0].content, /CYBER-SORCERY/);
    assert.deepEqual(messages[messages.length - 1], {
      role: "user",
      content: "what is brewing?",
    });
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat() includes recalled memories in the brain prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    memory: { file: join(dir, "memory.jsonl") },
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "You are Circe.",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] });
        return jsonResponse({ choices: [{ message: { content: "Of course, Master." } }] });
      },
    },
  });
  try {
    runtime.memory.remember("Master's favorite game is Elden Ring", ["game"]);
    await runtime.chat("which game should we play?");

    const messages = bodies[bodies.length - 1]?.messages ?? [];
    assert.match(messages[0].content, /\[EPISODIC MEMORY\]/);
    assert.match(messages[0].content, /Master's favorite game is Elden Ring/);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat() throws when no brain is configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const runtime = new CirceRuntime({ port: 0, logFile: join(dir, "events.jsonl") });
  try {
    await assert.rejects(() => runtime.chat("hello?"), /brain not configured/);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat() reflects when asked and emits brain-reflect on the bus", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const reflected: Record<string, unknown>[] = [];
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "You are Circe.",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] });
        return jsonResponse({
          choices: [{ message: { content: bodies.length === 1 ? "rough" : "smooth" } }],
        });
      },
    },
  });
  runtime.bus.on((event) => {
    if (event.type === "brain-reflect") reflected.push(event);
  });
  try {
    const result = await runtime.chat("hello", { reflect: true });

    assert.equal(result.answer, "smooth");
    assert.equal(bodies.length, 2);
    assert.equal(reflected.length, 1);
    assert.equal(reflected[0].draft, "rough");
    assert.equal(reflected[0].final, "smooth");
    assert.equal(typeof reflected[0].seq, "number");
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat() with tools runs the tool loop and emits tool events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const toolEvents: string[] = [];
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    tools: true,
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "You are Circe.",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] });
        if (bodies.length === 1) {
          return jsonResponse({ choices: [{ message: { content: '{"tool":"context","args":{}}' } }] });
        }
        return jsonResponse({ choices: [{ message: { content: "The scene is lively, Master~" } }] });
      },
    },
  });
  runtime.bus.on((event) => {
    if (event.type.startsWith("tool-")) toolEvents.push(event.type);
  });
  try {
    runtime.stream.pushChat("alice", "hello circe");
    const result = await runtime.chat("what is happening?", { tools: true });

    assert.equal(result.answer, "The scene is lively, Master~");
    assert.deepEqual(toolEvents, ["tool-call", "tool-result"]);

    // The tool result fed back to the model carries the live chat context.
    const second = bodies[1]?.messages ?? [];
    assert.match(second[0].content, /\[TOOLS\]/);
    assert.match(second[3].content, /TOOL RESULT \(context\)/);
    assert.match(second[3].content, /alice: hello circe/);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat() with tools throws when the tool belt is not enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "You are Circe.",
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "hi" } }] }),
    },
  });
  try {
    await assert.rejects(() => runtime.chat("hi", { tools: true }), /tools not enabled/);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

function sseResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

test("chat() with stream speaks sentences as they arrive and emits stream events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const events: Record<string, unknown>[] = [];
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "You are Circe.",
      fetchImpl: async () =>
        sseResponse(
          'data: {"choices":[{"delta":{"content":"*giggles* "}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"First sentence. Second sentence."}}]}\n\n' +
            "data: [DONE]\n\n",
        ),
    },
  });
  runtime.bus.on((event) => events.push(event));
  try {
    const result = await runtime.chat("hi", { stream: true });

    assert.equal(result.answer, "*giggles* First sentence. Second sentence.");
    assert.equal(result.processed.speech, "First sentence. Second sentence.");
    assert.equal(result.processed.cues.length, 1);
    assert.equal(result.processed.cues[0].expression, "joy");

    const types = events.map((e) => e.type);
    assert.equal(types[0], "stream-start");
    assert.equal(types[types.length - 1], "stream-end");
    const speechEvents = events.filter((e) => e.type === "speech");
    assert.deepEqual(
      speechEvents.map((e) => e.text),
      ["First sentence.", "Second sentence."],
    );
    assert.ok(speechEvents.every((e) => e.streaming === true));
    const expression = events.find((e) => e.type === "expression");
    assert.equal(expression?.marker, "giggles");
    const lipStarts = events.filter((e) => e.type === "lip-start");
    assert.equal(lipStarts.length, 2);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat() streams by default when the runtime stream option is set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const events: string[] = [];
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    stream: true,
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "You are Circe.",
      fetchImpl: async () =>
        sseResponse(
          'data: {"choices":[{"delta":{"content":"Straight to voice."}}]}\n\ndata: [DONE]\n\n',
        ),
    },
  });
  runtime.bus.on((event) => events.push(event.type));
  try {
    const result = await runtime.chat("hi");
    assert.equal(result.answer, "Straight to voice.");
    assert.ok(events.includes("stream-start"));
    assert.ok(events.includes("stream-end"));
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat() rejects stream combined with reflect or tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "s",
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "hi" } }] }),
    },
  });
  try {
    await assert.rejects(
      () => runtime.chat("hi", { stream: true, reflect: true }),
      /stream cannot be combined/,
    );
    await assert.rejects(
      () => runtime.chat("hi", { stream: true, tools: true }),
      /stream cannot be combined/,
    );
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat() honors an explicit reflect request over a session stream default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const bodies: { stream?: boolean }[] = [];
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    stream: true,
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "s",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as { stream?: boolean });
        return jsonResponse({ choices: [{ message: { content: "One careful pass." } }] });
      },
    },
  });
  try {
    const result = await runtime.chat("hi", { reflect: true });
    assert.equal(result.answer, "One careful pass.");
    assert.equal(bodies.length, 2, "two-pass reflection ran");
    assert.ok(bodies.every((body) => body.stream === false));
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat() attaches the latest vision frame when vision is enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const bodies: { messages: { role: string; content: unknown }[] }[] = [];
  const visionEvents: string[] = [];
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    vision: {
      outDir: join(dir, "frames"),
      runImpl: async (_cmd, args) => {
        writeFileSync(String(args[args.length - 1]), "jpegbytes");
        return { ok: true };
      },
    },
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "You are Circe.",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: unknown }[] });
        return jsonResponse({ choices: [{ message: { content: "I can see the arena, Master." } }] });
      },
    },
  });
  runtime.bus.on((event) => {
    if (event.type === "vision-frame") visionEvents.push(String(event.file));
  });
  try {
    const frame = await runtime.vision?.capture();
    assert.equal(frame?.ok, true);
    await runtime.chat("what do you see?");

    const messages = bodies[0]?.messages ?? [];
    const content = messages[messages.length - 1].content;
    assert.ok(Array.isArray(content), "user turn becomes multimodal");
    assert.equal(content[0].type, "text");
    const part = content[1] as { type: string; image_url: { url: string } };
    assert.equal(part.type, "image_url");
    assert.match(part.image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(visionEvents.length, 1);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat() reflects through the critic agent when one is configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const writerBodies: { model: string }[] = [];
  const criticBodies: { model: string }[] = [];
  const reflected: Record<string, unknown>[] = [];
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    brain: {
      baseUrl: "http://writer/v1",
      model: "writer-model",
      systemPrompt: "You are Circe.",
      fetchImpl: async (_url, init) => {
        writerBodies.push(JSON.parse(String(init?.body)) as { model: string });
        return jsonResponse({ choices: [{ message: { content: "draft by writer" } }] });
      },
    },
    critic: {
      baseUrl: "http://critic/v1",
      model: "critic-model",
      systemPrompt: "You are the critic.",
      fetchImpl: async (_url, init) => {
        criticBodies.push(JSON.parse(String(init?.body)) as { model: string });
        return jsonResponse({ choices: [{ message: { content: "polished by critic" } }] });
      },
    },
  });
  runtime.bus.on((event) => {
    if (event.type === "brain-reflect") reflected.push(event);
  });
  try {
    const result = await runtime.chat("hi", { reflect: true });
    assert.equal(result.answer, "polished by critic");
    assert.equal(writerBodies.length, 1);
    assert.equal(criticBodies.length, 1);
    assert.equal(writerBodies[0].model, "writer-model");
    assert.equal(criticBodies[0].model, "critic-model");
    assert.equal(reflected.length, 1);
    assert.equal(reflected[0].critic, true);
    assert.equal(reflected[0].draft, "draft by writer");
    assert.equal(reflected[0].final, "polished by critic");
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goals activate on chat, complete when satisfied, and enter the brain prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const bodies: { messages: { role: string; content: unknown }[] }[] = [];
  const goalEvents: { type: string; id: string }[] = [];
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    goals: [{ id: "chat-moving", description: "get the chat moving", check: (c) => c.chat.length >= 2 }],
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "You are Circe.",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: unknown }[] });
        return jsonResponse({ choices: [{ message: { content: "Chat, say something!" } }] });
      },
    },
  });
  runtime.bus.on((event) => {
    if (event.type === "goal-active" || event.type === "goal-done") {
      goalEvents.push({ type: event.type, id: String(event.id) });
    }
  });
  try {
    runtime.stream.pushChat("alice", "first line");
    assert.deepEqual(goalEvents, [{ type: "goal-active", id: "chat-moving" }]);
    assert.equal(runtime.goals.active()?.id, "chat-moving");

    await runtime.chat("hello");
    const system = bodies[0]?.messages[0];
    assert.match(String(system?.content), /\[CURRENT GOAL\]/);
    assert.match(String(system?.content), /get the chat moving/);

    runtime.stream.pushChat("bob", "second line");
    assert.deepEqual(goalEvents, [
      { type: "goal-active", id: "chat-moving" },
      { type: "goal-done", id: "chat-moving" },
    ]);
    assert.equal(runtime.goals.active(), null);
    assert.equal(runtime.goals.status().done, 1);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("viewer registry tracks incoming messages and injects relationship context into chat()", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  let capturedBody = "";
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "You are Circe.",
      fetchImpl: async (_url, init) => {
        capturedBody = String(init?.body ?? "");
        return jsonResponse({
          choices: [{ message: { content: "Ah, Alice! Welcome back." } }],
        });
      },
    },
  });

  try {
    // Push chat messages to simulate active stream
    runtime.stream.pushChat("Alice", "Hello mistress Circe!");
    runtime.stream.pushChat("Alice", "Another message!");

    const viewer = runtime.viewers.get("alice");
    assert.ok(viewer);
    assert.equal(viewer.user, "alice");
    assert.equal(viewer.messageCount, 2);

    // Add note and affinity
    runtime.viewers.addNote("alice", "favorite potion is moonflower");
    runtime.viewers.adjustAffinity("alice", 30);

    // Call chat with user="alice"
    const reply = await runtime.chat("What do you think of me?", {}, "alice");
    assert.equal(reply.answer, "Ah, Alice! Welcome back.");

    // Check captured body contains viewer context block
    assert.match(capturedBody, /\[VIEWER CONTEXT: alice\]/);
    assert.match(capturedBody, /favorite potion is moonflower/);
    assert.match(capturedBody, /\+30/);

    // Set persona override on viewer
    runtime.viewers.setPersona("alice", "evil-neuro");
    await runtime.chat("Teach me something dark", {}, "alice");
    // Evil Neuro persona prompt should now be used for Alice's turn
    assert.match(capturedBody, /Evil Neuro/);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("multi-turn goal planning records turns, auto-advances, and handles tool advance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const goalStepEvents: { id: string; index: number; reason?: string }[] = [];
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    goals: [
      {
        id: "multi-arc",
        description: "run a 3-step arc",
        maxTurnsPerStep: 1,
        steps: ["Step 1: Hook", "Step 2: Engage", "Step 3: Payoff"],
        check: () => false,
      },
    ],
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "You are Circe.",
      fetchImpl: async () =>
        jsonResponse({ choices: [{ message: { content: "I cast a spell!" } }] }),
    },
  });
  runtime.bus.on((event) => {
    if (event.type === "goal-step") {
      goalStepEvents.push({
        id: String(event.id),
        index: Number(event.index),
        reason: typeof event.reason === "string" ? event.reason : undefined,
      });
    }
  });

  try {
    runtime.stream.pushChat("alice", "hello");
    assert.equal(runtime.goals.status().active?.stepIndex, 0);

    // 1st chat turn -> maxTurnsPerStep (1) reached -> auto-advances to step 1 (0-based)
    await runtime.chat("hi");
    assert.equal(runtime.goals.status().active?.stepIndex, 1);
    assert.equal(goalStepEvents.length, 1);
    assert.equal(goalStepEvents[0].index, 1);
    assert.equal(goalStepEvents[0].reason, "turns-exceeded");

    // Manual advance via runtime.advanceGoalStep
    const adv = runtime.advanceGoalStep("manual beat transition");
    assert.equal(adv.advanced, true);
    assert.equal(adv.index, 2);
    assert.equal(runtime.goals.status().active?.stepIndex, 2);
    assert.equal(goalStepEvents.length, 2);
    assert.equal(goalStepEvents[1].index, 2);
    assert.equal(goalStepEvents[1].reason, "manual beat transition");
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedules cues at their estimated positions on the speech timeline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    wpm: 12_000,
  });
  try {
    const seen: { marker: string; at: number }[] = [];
    runtime.bus.on((event) => {
      if (event.type === "expression") {
        seen.push({ marker: String(event.marker), at: Date.now() });
      }
    });

    const start = Date.now();
    await runtime.processReply("*giggles* one two three *pouts* end");

    assert.equal(seen.length, 1, "only the immediate cue should have fired yet");
    assert.equal(seen[0].marker, "giggles");

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(seen.length, 2);
    assert.equal(seen[1].marker, "pouts");
    assert.ok(seen[1].at - start >= 10, `delayed cue fired too early: ${seen[1].at - start}ms`);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recap() distills with the brain and stores recap-tagged memories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    memory: { file: join(dir, "memory.jsonl") },
    brain: {
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "You are Circe.",
      fetchImpl: async () =>
        jsonResponse({
          choices: [
            {
              message: {
                content: "- Alice welcomed Circe back.\n- Circe promised a potion segment.",
              },
            },
          ],
        }),
    },
  });
  try {
    runtime.stream.pushChat("alice", "hello circe");
    await runtime.processReply("*giggles* Welcome back, piglet.");
    const result = await runtime.recap();
    assert.equal(result.source, "brain");
    assert.equal(result.facts.length, 2);
    const stored = runtime.memory.all().filter((fact) => fact.tags.includes("recap"));
    assert.equal(stored.length, 2);
    assert.match(stored[0].text, /Alice welcomed Circe/);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recap() falls back to deterministic stats without a brain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    memory: { file: join(dir, "memory.jsonl") },
  });
  try {
    runtime.stream.pushChat("alice", "hi");
    await runtime.processReply("Hello there.");
    const result = await runtime.recap();
    assert.equal(result.source, "fallback");
    assert.ok(result.facts.length >= 2);
    assert.equal(runtime.memory.all().filter((fact) => fact.tags.includes("recap")).length, result.facts.length);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop() writes a recap when recap.onStop is enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-rt-"));
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    memory: { file: join(dir, "memory.jsonl") },
    recap: { onStop: true },
  });
  try {
    runtime.stream.pushChat("bob", "oink");
    await runtime.processReply("Careful, piglet.");
    assert.equal(runtime.recapOnStop, true);
    await runtime.stop();
    assert.ok(runtime.memory.all().some((fact) => fact.tags.includes("recap")));
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
