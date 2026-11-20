import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fallbackRecap,
  parseBulletFacts,
  sessionRecap,
  SessionDigest,
} from "../recap.js";
import { CirceBrain } from "../brain.js";

function digest(overrides: Partial<SessionDigest> = {}): SessionDigest {
  const now = Date.now();
  return {
    chat: [
      { user: "alice", message: "hello circe", ts: now - 3000 },
      { user: "bob", message: "oink", ts: now - 2000 },
      { user: "alice", message: "potion please", ts: now - 1000 },
    ],
    replies: ["Welcome back, piglets.", "One moonlight potion, coming up."],
    goalsDone: 2,
    startedAt: now - 3_600_000,
    endedAt: now,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("parseBulletFacts handles bullets, numbering, dedupe, and headers", () => {
  const text = [
    "Here are the memories:",
    "- Alice loves potion jokes",
    "* Bob asked about Malenia",
    "2. Alice loves potion jokes",
    "3) Circe promised a lore segment",
    "```",
  ].join("\n");
  assert.deepEqual(parseBulletFacts(text), [
    "Alice loves potion jokes",
    "Bob asked about Malenia",
    "Circe promised a lore segment",
  ]);
});

test("fallbackRecap summarizes stats, chatters, replies, and goals", () => {
  const result = fallbackRecap(digest());
  assert.equal(result.source, "fallback");
  assert.ok(result.facts.length >= 4);
  assert.match(result.facts[0], /60 minutes with 3 chat messages from 2 chatters/);
  assert.match(result.facts[1], /alice \(2\), bob \(1\)/);
  assert.match(result.facts[2], /her last words were: "One moonlight potion, coming up\."/);
  assert.match(result.facts[3], /completed 2 of her session goals/);
  assert.equal(result.summary, result.facts[0]);
});

test("fallbackRecap works on an empty session without inventing chatters", () => {
  const result = fallbackRecap(digest({ chat: [], replies: [], goalsDone: 0 }));
  assert.equal(result.facts.length, 1);
  assert.match(result.facts[0], /0 chat messages from 0 chatters/);
});

test("sessionRecap uses the brain and caps facts", async () => {
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    fetchImpl: async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: [
                "- Alice gifted 5 subs and loves potion jokes.",
                "- The stream fought Malenia and lost twice.",
                "- Circe promised a lore segment next stream.",
                "- Bob asked about the spell lattice.",
                "- Extra fact that should be trimmed.",
                "- Another extra fact that should be trimmed.",
              ].join("\n"),
            },
          },
        ],
      }),
  });
  const result = await sessionRecap(brain, digest(), 4);
  assert.equal(result.source, "brain");
  assert.equal(result.facts.length, 4);
  assert.match(result.facts[0], /Alice gifted 5 subs/);
  assert.equal(result.summary, result.facts[0]);
});

test("sessionRecap falls back deterministically when the brain fails", async () => {
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  const result = await sessionRecap(brain, digest());
  assert.equal(result.source, "fallback");
  assert.ok(result.error);
  assert.match(result.facts[0], /60 minutes/);
});

test("sessionRecap falls back when the archivist returns no facts", async () => {
  const brain = new CirceBrain({
    baseUrl: "http://brain/v1",
    model: "m",
    systemPrompt: "s",
    fetchImpl: async () =>
      jsonResponse({ choices: [{ message: { content: "Here are the memories:" } }] }),
  });
  const result = await sessionRecap(brain, digest());
  assert.equal(result.source, "fallback");
  assert.match(result.error ?? "", /no facts/);
});

test("sessionRecap without a brain uses the fallback", async () => {
  const result = await sessionRecap(null, digest());
  assert.equal(result.source, "fallback");
  assert.ok(result.facts.length > 0);
});
