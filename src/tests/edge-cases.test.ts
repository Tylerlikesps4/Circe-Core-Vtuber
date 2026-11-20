import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../bus.js";
import { StreamContextFeed } from "../stream.js";
import { ViewerRegistry, normalizeUser } from "../viewers.js";
import { GoalTracker, Goal } from "../goals.js";
import { parseReply } from "../expression.js";
import { StreamingSpeech } from "../streamspeak.js";
import { EpisodicMemory } from "../memory.js";
import { fallbackRecap } from "../recap.js";

test("HTTP server handles malformed percent-encoded URIs without crashing", async () => {
  const bus = new EventBus();
  const viewers = new ViewerRegistry();
  const feed = new StreamContextFeed(bus, { port: 0, viewers });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;

    // Malformed URI percent encoding
    const resGet = await fetch(`${base}/viewers/%E0%A4%A`);
    assert.equal(resGet.status, 404);

    const resPost = await fetch(`${base}/viewers/%FF`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delta: 5 }),
    });
    // Either 200 (safe fallback) or 400/404, but definitely not 500 or crash
    assert.ok(resPost.status < 500);

    // Empty user path
    const resEmpty = await fetch(`${base}/viewers/   `);
    assert.equal(resEmpty.status, 400);
  } finally {
    await feed.stop();
  }
});

test("HTTP server handles body too large and invalid JSON gracefully", async () => {
  const bus = new EventBus();
  const feed = new StreamContextFeed(bus, { port: 0, maxBodyBytes: 64 });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;

    // Payload exceeding maxBodyBytes
    const largeRes = await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "a", message: "x".repeat(100) }),
    });
    assert.equal(largeRes.status, 413);

    // Malformed JSON payload
    const badJson = await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "this is not json {",
    });
    assert.equal(badJson.status, 400);
  } finally {
    await feed.stop();
  }
});

test("HTTP server handles malformed query parameters without crashing", async () => {
  const bus = new EventBus();
  const viewers = new ViewerRegistry();
  viewers.recordMessage("alice");
  const feed = new StreamContextFeed(bus, { port: 0, viewers });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;
    const res = await (
      await fetch(`${base}/viewers?tier=bogus&sort=unknown&limit=-10`)
    ).json();
    assert.equal(res.ok, true);
    assert.equal(Array.isArray(res.viewers), true);
  } finally {
    await feed.stop();
  }
});

test("ViewerRegistry handles non-string and NaN inputs defensively", () => {
  const reg = new ViewerRegistry();
  // normalizeUser defensive checks
  assert.equal(normalizeUser(null as unknown as string), "");
  assert.equal(normalizeUser(undefined as unknown as string), "");
  assert.equal(normalizeUser(123 as unknown as string), "");

  // getOrCreate with empty string falls back to "anon"
  const anon = reg.getOrCreate("");
  assert.equal(anon.user, "anon");

  // adjustAffinity with NaN delta does not corrupt affinity
  reg.adjustAffinity("bob", NaN);
  assert.equal(reg.get("bob")?.affinity, 0);

  // all() with limit: 0 returns empty array
  reg.recordMessage("alice");
  assert.deepEqual(reg.all({ limit: 0 }), []);
});

test("GoalTracker isolates throwing check functions without crashing", () => {
  const buggyGoal: Goal = {
    id: "buggy",
    description: "test bug handling",
    check: () => {
      throw new Error("unhandled user check error");
    },
    steps: [
      {
        description: "step with bug",
        check: () => {
          throw new Error("unhandled step error");
        },
      },
    ],
  };

  const tracker = new GoalTracker([buggyGoal]);
  // evaluate should not throw
  const change = tracker.evaluate({ chat: [], now: Date.now() });
  assert.equal(change.completed, undefined);
  assert.equal(tracker.active()?.id, "buggy");

  // advance on goal with no steps returns advanced: false
  const emptyGoalTracker = new GoalTracker([{ id: "empty", description: "none", check: () => false }]);
  emptyGoalTracker.evaluate({ chat: [], now: Date.now() });
  const adv = emptyGoalTracker.advanceStep();
  assert.equal(adv.advanced, false);
});

test("parseReply and StreamingSpeech handle non-string inputs safely", () => {
  assert.deepEqual(parseReply(null as unknown as string), { speech: "", cues: [] });
  assert.deepEqual(parseReply(undefined as unknown as string), { speech: "", cues: [] });

  const splitter = new StreamingSpeech({
    speak: async (text) => ({ ok: true, backend: "none", text }),
  });
  // feed non-string does not throw
  splitter.feed(null as unknown as string);
  splitter.feed(undefined as unknown as string);
  assert.equal(splitter.speechText(), "");
});

test("EpisodicMemory handles malformed tags and non-string query safely", () => {
  const mem = new EpisodicMemory();
  // null tags or non-string tags
  const fact = mem.remember("clean fact", [null as unknown as string, "valid-tag", 123 as unknown as string]);
  assert.deepEqual(fact.tags, ["valid-tag"]);

  // recall with non-string query does not throw
  const recalled = mem.recall(null as unknown as string);
  assert.ok(Array.isArray(recalled));
});

test("fallbackRecap handles corrupted timestamps and malformed chat arrays", () => {
  const recap = fallbackRecap({
    chat: [null as unknown as { user: string; message: string; ts: number }],
    replies: [],
    goalsDone: 0,
    startedAt: NaN,
    endedAt: NaN,
  });

  assert.equal(recap.source, "fallback");
  assert.ok(recap.facts.length > 0);
  // Ensure duration is not NaN
  assert.equal(recap.facts[0].includes("NaN"), false);
});
