import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CirceBrain, LlmMessage } from "../brain.js";
import { ToolRegistry } from "../tools.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("posts an OpenAI-compatible chat completion with persona and context", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const brain = new CirceBrain({
    baseUrl: "http://127.0.0.1:11434/v1/",
    model: "llama3.1:8b",
    apiKey: "secret",
    systemPrompt: "You are Circe.",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ choices: [{ message: { content: "*smugs* Hello." } }] });
    },
  });

  const answer = await brain.reply("hi", "[STREAM CONTEXT]\nChat: none");
  assert.equal(answer, "*smugs* Hello.");
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].url), "http://127.0.0.1:11434/v1/chat/completions");

  const body = JSON.parse(String(calls[0].init?.body)) as {
    model: string;
    messages: { role: string; content: string }[];
  };
  assert.equal(body.model, "llama3.1:8b");
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /You are Circe\./);
  assert.match(body.messages[0].content, /STREAM CONTEXT/);
  assert.deepEqual(body.messages[1], { role: "user", content: "hi" });

  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer secret");
});

test("keeps a rolling history and resets on demand", async () => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "sys",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] });
      return jsonResponse({ choices: [{ message: { content: "first reply" } }] });
    },
  });

  await brain.reply("one");
  await brain.reply("two");
  const messages = bodies[bodies.length - 1]?.messages ?? [];
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[1], { role: "user", content: "one" });
  assert.deepEqual(messages[2], { role: "assistant", content: "first reply" });
  assert.deepEqual(messages[3], { role: "user", content: "two" });

  brain.reset();
  await brain.reply("three");
  const afterReset = bodies[bodies.length - 1]?.messages ?? [];
  assert.equal(afterReset.length, 2);
  assert.deepEqual(afterReset[1], { role: "user", content: "three" });
});
test("caps the history at maxHistory turns", async () => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "sys",
    maxHistory: 2,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] });
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    },
  });

  await brain.reply("one");
  await brain.reply("two");
  await brain.reply("three");
  const messages = bodies[bodies.length - 1]?.messages ?? [];
  // system + last two history turns + the new user turn
  assert.equal(messages.length, 4);
});

test("throws on HTTP errors and empty replies", async () => {
  const bad = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  await assert.rejects(() => bad.reply("hi"), /brain HTTP 500/);

  const empty = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "   " } }] }),
  });
  await assert.rejects(() => empty.reply("hi"), /empty reply/);
});

test("reflection drafts, critiques, and stores only the final reply", async () => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const reflected: { draft: string; final: string }[] = [];
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "You are Circe.",
    reflect: true,
    onReflect: (info) => reflected.push({ draft: info.draft, final: info.final }),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] });
      return jsonResponse({
        choices: [{ message: { content: bodies.length === 1 ? "draft words" : "polished final" } }],
      });
    },
  });

  const answer = await brain.reply("say something");
  assert.equal(answer, "polished final");
  assert.equal(bodies.length, 2, "one draft call + one critique call");

  // Draft pass: standard stack (system + user).
  const draftMessages = bodies[0]?.messages ?? [];
  assert.equal(draftMessages[0].role, "system");
  assert.deepEqual(draftMessages[draftMessages.length - 1], { role: "user", content: "say something" });

  // Critique pass: critic system prompt, original message + draft in one user turn.
  const criticMessages = bodies[1]?.messages ?? [];
  assert.equal(criticMessages.length, 2, "critique pass skips conversation history");
  assert.match(criticMessages[0].content, /You are Circe\./);
  assert.match(criticMessages[0].content, /inner critic/);
  assert.match(criticMessages[1].content, /say something/);
  assert.match(criticMessages[1].content, /draft words/);

  assert.deepEqual(reflected, [{ draft: "draft words", final: "polished final" }]);
  assert.deepEqual(brain.turns(), [
    { role: "user", content: "say something" },
    { role: "assistant", content: "polished final" },
  ]);
});

test("reflection is off by default and can be forced per call", async () => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] });
      return jsonResponse({
        choices: [{ message: { content: bodies.length === 1 ? "raw" : "refined" } }],
      });
    },
  });

  assert.equal(await brain.reply("one"), "raw");
  assert.equal(bodies.length, 1);

  assert.equal(await brain.reply("two", "", { reflect: true }), "refined");
  assert.equal(bodies.length, 3, "forced reflect adds the critique pass");

  // Session-level setting still wins for unforced calls.
  assert.equal(await brain.reply("three"), "refined");
  assert.equal(bodies.length, 4);
});

test("reflection falls back to the draft when the critique pass fails", async () => {
  let call = 0;
  const reflected: { draft: string; final: string; error?: string }[] = [];
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    reflect: true,
    onReflect: (info) => reflected.push(info),
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return jsonResponse({ choices: [{ message: { content: "best draft" } }] });
      return new Response("critic exploded", { status: 502 });
    },
  });

  const answer = await brain.reply("hello");
  assert.equal(answer, "best draft");
  assert.deepEqual(reflected, [
    { draft: "best draft", final: "best draft", error: "brain HTTP 502" },
  ]);
  assert.deepEqual(brain.turns(), [
    { role: "user", content: "hello" },
    { role: "assistant", content: "best draft" },
  ]);
});

test("reflection delegates the critique pass to an external critic agent", async () => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const criticCalls: LlmMessage[][] = [];
  const brain = new CirceBrain({
    baseUrl: "http://writer/v1",
    model: "writer",
    systemPrompt: "You are Circe.",
    reflect: true,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] });
      return jsonResponse({ choices: [{ message: { content: "rough draft" } }] });
    },
  });

  const answer = await brain.reply("say something", "", {
    critic: async (messages) => {
      criticCalls.push(messages);
      return "critic-approved final";
    },
  });

  assert.equal(answer, "critic-approved final");
  assert.equal(bodies.length, 1, "the writer makes only the draft call");
  assert.equal(criticCalls.length, 1);
  const criticMessages = criticCalls[0];
  assert.match(String(criticMessages[0].content), /inner critic/);
  assert.match(String(criticMessages[1].content), /rough draft/);
  assert.deepEqual(brain.turns(), [
    { role: "user", content: "say something" },
    { role: "assistant", content: "critic-approved final" },
  ]);
});

test("execute runs a raw completion without touching history", async () => {
  const brain = new CirceBrain({
    baseUrl: "http://critic/v1",
    model: "critic",
    systemPrompt: "You are the critic.",
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "polished" } }] }),
  });
  const result = await brain.execute([
    { role: "system", content: "You are the critic." },
    { role: "user", content: "Draft: rough" },
  ]);
  assert.equal(result, "polished");
  assert.equal(brain.turns().length, 0);
});

test("askWithTools runs the observe-plan-act loop and stores only the final answer", async () => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const seen: { tool: string; ok: boolean }[] = [];
  const registry = new ToolRegistry([
    {
      name: "memory_recall",
      description: "recall facts",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      run: ({ query }) => ({ facts: [{ text: `fact about ${query}` }] }),
    },
  ]);
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "You are Circe.",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] });
      if (bodies.length === 1) {
        return jsonResponse({
          choices: [{ message: { content: '{"tool":"memory_recall","args":{"query":"games"}}' } }],
        });
      }
      return jsonResponse({ choices: [{ message: { content: "We played that one, Master~" } }] });
    },
  });

  const answer = await brain.askWithTools("what did we play?", "[STREAM CONTEXT]", {
    tools: registry,
    onTool: (call, outcome) => seen.push({ tool: call.tool, ok: outcome.ok }),
  });

  assert.equal(answer, "We played that one, Master~");
  assert.equal(bodies.length, 2);
  assert.deepEqual(seen, [{ tool: "memory_recall", ok: true }]);

  // Second call: the model sees the tool result as a user turn.
  const second = bodies[1]?.messages ?? [];
  assert.match(second[0].content, /\[TOOLS\]/);
  assert.match(second[0].content, /memory_recall/);
  assert.match(second[3].content, /TOOL RESULT \(memory_recall\)/);
  assert.match(second[3].content, /fact about games/);

  assert.deepEqual(brain.turns(), [
    { role: "user", content: "what did we play?" },
    { role: "assistant", content: "We played that one, Master~" },
  ]);
});

test("askWithTools feeds tool errors back and throws when rounds run out", async () => {
  const failing = new ToolRegistry([
    {
      name: "mana",
      description: "meter",
      parameters: { type: "object", properties: {} },
      run: () => {
        throw new Error("no mana");
      },
    },
  ]);
  let call = 0;
  const errors: { tool: string; ok: boolean }[] = [];
  const recovering = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return jsonResponse({ choices: [{ message: { content: '{"tool":"mana","args":{}}' } }] });
      return jsonResponse({ choices: [{ message: { content: "The meter is broken, but I live~" } }] });
    },
  });
  const answer = await recovering.askWithTools("status?", "", {
    tools: failing,
    onTool: (_, outcome) => errors.push({ tool: "mana", ok: outcome.ok }),
  });
  assert.equal(answer, "The meter is broken, but I live~");
  assert.deepEqual(errors, [{ tool: "mana", ok: false }]);

  const stuck = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    fetchImpl: async () =>
      jsonResponse({ choices: [{ message: { content: '{"tool":"mana","args":{}}' } }] }),
  });
  await assert.rejects(
    () => stuck.askWithTools("status?", "", { tools: failing, maxRounds: 2 }),
    /tool loop exceeded 2 rounds/,
  );
});

test("askWithTools returns plain replies without calling any tool", async () => {
  let calls = 0;
  const registry = new ToolRegistry([]);
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ choices: [{ message: { content: "No tools needed, dear." } }] });
    },
  });
  assert.equal(await brain.askWithTools("hi", "", { tools: registry }), "No tools needed, dear.");
  assert.equal(calls, 1);
});

function sseResponse(chunks: { content: string }[], final = true): Response {
  const lines = chunks
    .map((chunk) => `data: ${JSON.stringify({ choices: [{ delta: chunk }] })}\n\n`)
    .join("");
  return new Response(lines + (final ? "data: [DONE]\n\n" : ""), {
    headers: { "content-type": "text/event-stream" },
  });
}

test("streamReply parses SSE deltas and streams chunks to the caller", async () => {
  const bodies: { stream?: boolean }[] = [];
  const chunks: { chunk: string; full: string }[] = [];
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "You are Circe.",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { stream?: boolean });
      return sseResponse([{ content: "*giggles* " }, { content: "Hello, Master." }]);
    },
  });

  const answer = await brain.streamReply("hi", "[STREAM CONTEXT]", {
    onChunk: (chunk, full) => chunks.push({ chunk, full }),
  });

  assert.equal(answer, "*giggles* Hello, Master.");
  assert.equal(bodies[0].stream, true);
  assert.deepEqual(chunks, [
    { chunk: "*giggles* ", full: "*giggles* " },
    { chunk: "Hello, Master.", full: "*giggles* Hello, Master." },
  ]);
  assert.deepEqual(brain.turns(), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "*giggles* Hello, Master." },
  ]);
});

test("streamReply handles chunks split across SSE lines and a missing final newline", async () => {
  const deltas: string[] = [];
  const body =
    'data: {"choices":[{"delta":{"content":"split"}}]}\n\ndata: {"choices":[{"delta":{"content":" word"}}]}\n\ndata: [DONE]\n\n';
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    fetchImpl: async () => new Response(body),
  });
  const answer = await brain.streamReply("hi", "", { onChunk: (chunk) => deltas.push(chunk) });
  assert.equal(answer, "split word");
  assert.deepEqual(deltas, ["split", " word"]);
});

test("streamReply throws on HTTP errors, stream errors, and empty streams", async () => {
  const httpFail = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  await assert.rejects(() => httpFail.streamReply("hi"), /brain HTTP 500/);

  const serverError = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    fetchImpl: async () =>
      new Response('data: {"error":{"message":"model exploded"}}\n\n'),
  });
  await assert.rejects(() => serverError.streamReply("hi"), /brain stream error: model exploded/);

  const empty = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    fetchImpl: async () => new Response("data: [DONE]\n\n"),
  });
  await assert.rejects(() => empty.streamReply("hi"), /empty reply/);
});

test("attaches the vision frame to user turns when getFrame is set", async () => {
  const bodies: { messages: { role: string; content: unknown }[] }[] = [];
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    getFrame: () => ({ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: unknown }[] });
      return jsonResponse({ choices: [{ message: { content: "I see the scene!" } }] });
    },
  });
  await brain.reply("what do you see?");
  const messages = bodies[0]?.messages ?? [];
  assert.deepEqual(messages[messages.length - 1].content, [
    { type: "text", text: "what do you see?" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
  ]);
});

test("user turns stay plain text without a getFrame hook", async () => {
  const bodies: { messages: { role: string; content: unknown }[] }[] = [];
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: unknown }[] });
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    },
  });
  await brain.reply("hello");
  const messages = bodies[0]?.messages ?? [];
  assert.equal(messages[messages.length - 1].content, "hello");
});

test("persists conversation history and reloads it on restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-brain-"));
  const file = join(dir, "history.jsonl");
  try {
    const first = new CirceBrain({
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "s",
      historyFile: file,
      fetchImpl: async () =>
        jsonResponse({ choices: [{ message: { content: "first reply" } }] }),
    });
    await first.reply("hello");
    assert.deepEqual(first.turns(), [
      { role: "user", content: "hello" },
      { role: "assistant", content: "first reply" },
    ]);

    const bodies: { messages: { role: string; content: string }[] }[] = [];
    const second = new CirceBrain({
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "s",
      historyFile: file,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] });
        return jsonResponse({ choices: [{ message: { content: "welcome back" } }] });
      },
    });
    assert.equal(second.turns().length, 2);

    await second.reply("again");
    const messages = bodies[bodies.length - 1]?.messages ?? [];
    assert.equal(messages.length, 4);
    assert.deepEqual(messages[1], { role: "user", content: "hello" });
    assert.deepEqual(messages[2], { role: "assistant", content: "first reply" });
    assert.deepEqual(messages[3], { role: "user", content: "again" });

    second.reset();
    assert.equal(second.turns().length, 0);
    assert.equal(readFileSync(file, "utf8"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skips corrupt history lines on load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-brain-"));
  const file = join(dir, "history.jsonl");
  try {
    writeFileSync(
      file,
      'garbage\n{"role":"user","content":"kept"}\n{"role":"system","content":"dropped"}\n',
    );
    const brain = new CirceBrain({
      baseUrl: "http://brain/v1",
      model: "m",
      systemPrompt: "s",
      historyFile: file,
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    });
    assert.deepEqual(brain.turns(), [{ role: "user", content: "kept" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

