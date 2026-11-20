import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinTools, parseToolCall, ToolRegistry, CirceTool } from "../tools.js";

test("parseToolCall extracts plain, fenced, and noisy JSON envelopes", () => {
  assert.deepEqual(parseToolCall('{"tool":"mana","args":{}}'), {
    tool: "mana",
    args: {},
  });
  assert.deepEqual(
    parseToolCall('Sure, let me check.\n```json\n{"tool":"memory_recall","args":{"query":"game"}}\n```'),
    { tool: "memory_recall", args: { query: "game" } },
  );
  assert.deepEqual(parseToolCall('{"tool":"context","args":{"nested":{"a":1}}}'), {
    tool: "context",
    args: { nested: { a: 1 } },
  });
});

test("parseToolCall returns null for normal replies and malformed envelopes", () => {
  assert.equal(parseToolCall("Just a normal spoken reply!"), null);
  assert.equal(parseToolCall(""), null);
  assert.equal(parseToolCall('{"tool": "mana", "args":'), null); // broken JSON
  assert.equal(parseToolCall('{"args":{}}'), null); // missing tool
  assert.equal(parseToolCall('{"tool": 7, "args":{}}'), null); // tool not a string
  assert.equal(parseToolCall('{"tool":"mana","args":[1,2]}'), null); // args must be an object
  assert.equal(parseToolCall('{"tool":"mana","args":null}'), null); // args null
});

test("parseToolCall skips stray JSON prose and finds the real envelope", () => {
  assert.deepEqual(
    parseToolCall('I saw {"note":"hello"} earlier. {"tool":"mana","args":{}} please'),
    { tool: "mana", args: {} },
  );
  assert.deepEqual(
    parseToolCall('{"broken": } then {"tool":"context","args":{"a":1}}'),
    { tool: "context", args: { a: 1 } },
  );
  // Braces inside string values must not confuse the scanner.
  assert.deepEqual(parseToolCall('{"tool":"memory_recall","args":{"query":"a {weird} q"}}'), {
    tool: "memory_recall",
    args: { query: "a {weird} q" },
  });
});

test("ToolRegistry validates calls strictly before running", async () => {
  const calls: string[] = [];
  const registry = new ToolRegistry([
    {
      name: "echo",
      description: "echo",
      parameters: {
        type: "object",
        properties: { text: { type: "string" }, times: { type: "integer", minimum: 1, maximum: 3 } },
        required: ["text"],
        additionalProperties: false,
      },
      run: ({ text, times }) => {
        calls.push(String(text).repeat(Number(times ?? 1)));
        return { echoed: true };
      },
    },
    {
      name: "risky",
      description: "always fails",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: () => {
        throw new Error("ritual backfired");
      },
    },
  ]);

  const ok = await registry.call("echo", { text: "ha", times: 2 });
  assert.deepEqual(ok, { ok: true, result: { echoed: true } });
  assert.deepEqual(calls, ["haha"]);

  assert.deepEqual(await registry.call("nope", {}), {
    ok: false,
    error: "unknown tool: nope",
  });
  assert.deepEqual(await registry.call("echo", {}), {
    ok: false,
    error: 'invalid args for echo: missing "text"',
  });
  assert.deepEqual(await registry.call("echo", { text: "x", extra: 1 }), {
    ok: false,
    error: 'invalid args for echo: unknown argument "extra"',
  });
  assert.deepEqual(await registry.call("echo", { text: 3 }), {
    ok: false,
    error: 'invalid args for echo: "text" must be a string',
  });
  assert.deepEqual(await registry.call("echo", { text: "x", times: 99 }), {
    ok: false,
    error: 'invalid args for echo: "times" must be <= 3',
  });
  // Defensive: a null/array args payload becomes an error, never a crash.
  assert.deepEqual(await registry.call("echo", null as unknown as Record<string, unknown>), {
    ok: false,
    error: "invalid args for echo: args must be an object",
  });
  assert.deepEqual(await registry.call("risky", {}), {
    ok: false,
    error: "ritual backfired",
  });
});

test("register rejects duplicate tool names", () => {
  const tool: CirceTool = {
    name: "mana",
    description: "d",
    parameters: {},
    run: () => null,
  };
  const registry = new ToolRegistry([tool]);
  assert.throws(() => registry.register(tool), /duplicate tool mana/);
});

test("describe renders the tool belt with the JSON envelope contract", () => {
  const registry = new ToolRegistry([
    {
      name: "mana",
      description: "read the meter",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: () => ({ mana: "full" }),
    },
  ]);
  const text = registry.describe();
  assert.match(text, /mana: read the meter/);
  assert.match(text, /"tool"/);
  assert.match(text, /"args"/);
});

test("builtinTools binds context, mana, recall, and remember to the runtime", async () => {
  const remembered: { text: string; tags: string[] }[] = [];
  const tools = builtinTools({
    context: () => "[STREAM CONTEXT]\nChat: none",
    mana: async () => "[CYBER-SORCERY]\nmana: full",
    recall: (query, limit) => [{ id: "f1", text: `recalled ${query} x${limit}` }],
    recallGraph: (query, limit) => [{ fact: { id: "f2", text: `graph ${query} x${limit}` }, via: ["boss"] }],
    related: (tag, limit) => [{ tag: `${tag}-mate`, weight: limit }],
    remember: (text, tags) => {
      remembered.push({ text, tags });
      return { id: "f2", text, tags };
    },
  });
  const registry = new ToolRegistry(tools);

  assert.deepEqual(await registry.call("context", {}), {
    ok: true,
    result: { context: "[STREAM CONTEXT]\nChat: none" },
  });
  assert.deepEqual(await registry.call("mana", {}), {
    ok: true,
    result: { mana: "[CYBER-SORCERY]\nmana: full" },
  });
  assert.deepEqual(await registry.call("memory_recall", { query: "game", limit: 2 }), {
    ok: true,
    result: { facts: [{ id: "f1", text: "recalled game x2" }] },
  });
  assert.deepEqual(await registry.call("memory_recall", { query: "game", graph: true }), {
    ok: true,
    result: {
      facts: [{ fact: { id: "f2", text: "graph game x5" }, via: ["boss"] }],
    },
  });
  assert.deepEqual(await registry.call("memory_related", { tag: "elden-ring", limit: 3 }), {
    ok: true,
    result: { related: [{ tag: "elden-ring-mate", weight: 3 }] },
  });
  assert.deepEqual(await registry.call("memory_remember", { text: "note", tags: ["a", "b"] }), {
    ok: true,
    result: { fact: { id: "f2", text: "note", tags: ["a", "b"] } },
  });
  assert.deepEqual(remembered, [{ text: "note", tags: ["a", "b"] }]);

  // When goals interface is provided, goal_status and goal_advance are registered
  let advancedReason: string | undefined;
  const toolsWithGoals = builtinTools({
    context: () => "",
    mana: async () => "",
    recall: () => [],
    recallGraph: () => [],
    related: () => [],
    remember: () => ({}),
    goals: {
      status: () => ({ active: { id: "g1", description: "talk to chat" } }),
      advance: (reason) => {
        advancedReason = reason;
        return { advanced: true };
      },
    },
  });
  const regGoals = new ToolRegistry(toolsWithGoals);
  assert.deepEqual(await regGoals.call("goal_status", {}), {
    ok: true,
    result: { goal: { active: { id: "g1", description: "talk to chat" } } },
  });
  assert.deepEqual(await regGoals.call("goal_advance", { reason: "hook finished" }), {
    ok: true,
    result: { result: { advanced: true } },
  });
  assert.equal(advancedReason, "hook finished");

  // When viewers interface is provided, viewer_profile, viewer_note, viewer_affinity are registered
  let noteSaved: { user: string; note: string } | null = null;
  let affinityAdjusted: { user: string; delta: number; reason?: string } | null = null;
  const toolsWithViewers = builtinTools({
    context: () => "",
    mana: async () => "",
    recall: () => [],
    recallGraph: () => [],
    related: () => [],
    remember: () => ({}),
    viewers: {
      profile: (user) => ({ user, tier: "regular", affinity: 20 }),
      note: (user, note) => {
        noteSaved = { user, note };
        return { ok: true };
      },
      affinity: (user, delta, reason) => {
        affinityAdjusted = { user, delta, reason };
        return { ok: true };
      },
    },
  });
  const regViewers = new ToolRegistry(toolsWithViewers);
  assert.deepEqual(await regViewers.call("viewer_profile", { user: "alice" }), {
    ok: true,
    result: { profile: { user: "alice", tier: "regular", affinity: 20 } },
  });
  assert.deepEqual(await regViewers.call("viewer_note", { user: "alice", note: "likes potions" }), {
    ok: true,
    result: { result: { ok: true } },
  });
  assert.deepEqual(noteSaved, { user: "alice", note: "likes potions" });
  assert.deepEqual(await regViewers.call("viewer_affinity", { user: "alice", delta: 10, reason: "compliment" }), {
    ok: true,
    result: { result: { ok: true } },
  });
  assert.deepEqual(affinityAdjusted, { user: "alice", delta: 10, reason: "compliment" });
});
