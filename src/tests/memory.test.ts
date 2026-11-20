import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodicMemory } from "../memory.js";

test("remembers facts, dedupes text, and merges tags", () => {
  const memory = new EpisodicMemory();
  const first = memory.remember("Alice loves succulents", ["viewer:alice", "Gifts"]);
  assert.equal(first.id, 1);
  assert.deepEqual(first.tags, ["viewer:alice", "gifts"]);

  const again = memory.remember("alice LOVES succulents", ["lore"]);
  assert.equal(again.id, first.id);
  assert.deepEqual(again.tags, ["viewer:alice", "gifts", "lore"]);
  assert.equal(memory.size, 1);
});

test("recalls by keyword overlap and tags", () => {
  const memory = new EpisodicMemory();
  memory.remember("Master's favorite boss is Malenia", ["game:elden-ring"]);
  memory.remember("Chat loves potion jokes", ["lore"]);
  memory.remember("Alice gifted 50 subs in March", ["viewer:alice", "gift"]);

  const hits = memory.recall("what boss does master like", 2);
  assert.equal(hits[0].text, "Master's favorite boss is Malenia");

  const tagged = memory.recall("anything about viewer:alice", 2);
  assert.equal(tagged[0].text, "Alice gifted 50 subs in March");
});

test("recall bumps use counters and lastUsedAt", () => {
  const memory = new EpisodicMemory();
  memory.remember("Circe brews moonlight potions", ["lore"]);
  assert.equal(memory.all()[0].uses, 0);
  memory.recall("potion");
  const fact = memory.all()[0];
  assert.equal(fact.uses, 1);
  assert.ok(typeof fact.lastUsedAt === "number");
});

test("forget removes a fact", () => {
  const memory = new EpisodicMemory();
  const fact = memory.remember("temporary", []);
  assert.equal(memory.forget(fact.id), true);
  assert.equal(memory.forget(fact.id), false);
  assert.equal(memory.size, 0);
});

test("render returns a prompt block and empty string when empty", () => {
  const memory = new EpisodicMemory();
  assert.equal(memory.render("anything"), "");

  memory.remember("Master streams Souls games on weekends", ["game"]);
  const block = memory.render("souls");
  assert.match(block, /\[EPISODIC MEMORY\]/);
  assert.match(block, /Master streams Souls games on weekends \(game\)/);
});

test("persists facts to JSONL and reloads them", () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-mem-"));
  const file = join(dir, "memory.jsonl");
  try {
    const first = new EpisodicMemory({ file });
    first.remember("The stream turns one year old in May", ["stream"]);

    const second = new EpisodicMemory({ file });
    assert.equal(second.size, 1);
    const [fact] = second.all();
    assert.equal(fact.text, "The stream turns one year old in May");
    assert.deepEqual(fact.tags, ["stream"]);

    second.remember("Second fact", []);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forget rewrites the file without the removed fact", () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-mem-"));
  const file = join(dir, "memory.jsonl");
  try {
    const memory = new EpisodicMemory({ file });
    const kept = memory.remember("keep me", []);
    const dropped = memory.remember("drop me", []);
    memory.forget(dropped.id);

    const reloaded = new EpisodicMemory({ file });
    assert.equal(reloaded.size, 1);
    assert.equal(reloaded.all()[0].id, kept.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caps facts at maxFacts, keeping the newest", () => {
  const memory = new EpisodicMemory({ maxFacts: 2 });
  memory.remember("oldest");
  memory.remember("middle");
  memory.remember("newest");
  const texts = memory.all().map((f) => f.text);
  assert.deepEqual(texts, ["middle", "newest"]);
});

test("skips corrupt persistence lines on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-mem-"));
  const file = join(dir, "memory.jsonl");
  try {
    writeFileSync(file, 'garbage\n{"text":"survivor","tags":["x"]}\n');
    const memory = new EpisodicMemory({ file });
    assert.equal(memory.size, 1);
    assert.equal(memory.all()[0].text, "survivor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects empty facts", () => {
  const memory = new EpisodicMemory();
  assert.throws(() => memory.remember("   "), /cannot be empty/);
});

test("graphRecall pulls in facts connected through co-occurring tags", () => {
  const memory = new EpisodicMemory();
  memory.remember("Malenia is the hardest fight", ["game:elden-ring", "boss"]);
  memory.remember("Master's controller dies during bosses", ["boss", "hardware"]);
  memory.remember("Alice gifted 50 subs in March", ["viewer:alice", "gift"]);

  // Direct hit on the first fact; the "hardware" fact shares the "boss" tag
  // but matches no query keyword, so only the graph can surface it.
  const results = memory.graphRecall("malenia fight", 3);
  assert.equal(results[0].fact.text, "Malenia is the hardest fight");
  assert.deepEqual(results[0].via, []);
  assert.equal(results[1].fact.text, "Master's controller dies during bosses");
  assert.deepEqual(results[1].via, ["boss", "hardware"]);
  assert.equal(results.length, 2, "unrelated facts stay out");
});

test("graphRecall caps results and bumps use counters on graph hits", () => {
  const memory = new EpisodicMemory();
  memory.remember("seed lore fact", ["lore"]);
  const related = memory.remember("brew knowledge", ["lore"]);
  memory.graphRecall("seed lore", 2);
  const fact = memory.all().find((f) => f.id === related.id);
  assert.equal(fact?.uses, 1, "graph-recalled facts count as used");
});

test("relatedTags lists co-occurring tags and honors graph:false", () => {
  const memory = new EpisodicMemory();
  memory.remember("boss fact", ["elden-ring", "boss"]);
  memory.remember("cheese fact", ["boss", "cheese"]);
  assert.deepEqual(memory.relatedTags("boss"), [
    { tag: "cheese", weight: 1 },
    { tag: "elden-ring", weight: 1 },
  ]);

  const off = new EpisodicMemory({ graph: false });
  off.remember("fact", ["a", "b"]);
  assert.deepEqual(off.relatedTags("a"), []);
  const results = off.graphRecall("fact", 2);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].via, [], "graph:false yields direct hits only");
});

test("renderGraph annotates graph hits with via tags", () => {
  const memory = new EpisodicMemory();
  memory.remember("Malenia is the hardest boss", ["elden-ring", "boss"]);
  memory.remember("Controller dies during bosses", ["boss", "hardware"]);
  const block = memory.renderGraph("malenia", 2);
  assert.match(block, /\[EPISODIC MEMORY\]/);
  assert.match(block, /Malenia is the hardest boss/);
  assert.match(block, /Controller dies during bosses \(boss, hardware\) \[via: boss, hardware\]/);
});

test("forget and tag merges update the graph", () => {
  const memory = new EpisodicMemory();
  const a = memory.remember("fact a", ["x", "y"]);
  const b = memory.remember("fact b", ["y", "z"]);
  assert.deepEqual(memory.relatedTags("y").map((n) => n.tag), ["x", "z"]);

  memory.forget(a.id);
  assert.deepEqual(memory.relatedTags("y").map((n) => n.tag), ["z"]);

  // Merging tags into an existing fact re-wires its edges.
  memory.remember(b.text, ["w"]);
  assert.deepEqual(memory.relatedTags("w").map((n) => n.tag), ["y", "z"]);
  assert.deepEqual(memory.relatedTags("y").map((n) => n.tag), ["w", "z"]);
});

test("graph rebuilds from persisted facts on reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-mem-"));
  const file = join(dir, "memory.jsonl");
  try {
    const first = new EpisodicMemory({ file });
    first.remember("boss fact", ["elden-ring", "boss"]);
    first.remember("cheese fact", ["boss", "cheese"]);

    const reloaded = new EpisodicMemory({ file });
    assert.equal(reloaded.graphStats().edges, 2);
    const results = reloaded.graphRecall("elden-ring", 2);
    assert.equal(results.length, 2);
    assert.deepEqual(results[1].via, ["boss", "cheese"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
