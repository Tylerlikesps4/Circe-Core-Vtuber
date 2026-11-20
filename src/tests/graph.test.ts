import { test } from "node:test";
import assert from "node:assert/strict";
import { TagGraph } from "../graph.js";

test("co-occurring tags form weighted edges in both directions", () => {
  const graph = new TagGraph();
  graph.addFact(1, ["elden-ring", "boss"]);
  graph.addFact(2, ["elden-ring", "boss", "cheese"]);
  graph.addFact(3, ["boss", "cheese"]);

  assert.deepEqual(graph.neighbors("elden-ring"), [
    { tag: "boss", weight: 2 },
    { tag: "cheese", weight: 1 },
  ]);
  assert.deepEqual(graph.neighbors("cheese"), [
    { tag: "boss", weight: 2 },
    { tag: "elden-ring", weight: 1 },
  ]);
  assert.deepEqual(graph.stats(), { tags: 3, edges: 3, facts: 3 });
});

test("normalizes tags and ignores empty or single-tag facts", () => {
  const graph = new TagGraph();
  graph.addFact(1, ["  Elden-Ring ", "ELDEN-RING", ""]);
  graph.addFact(2, ["solo"]);
  assert.deepEqual(graph.neighbors("elden-ring"), []);
  assert.deepEqual(graph.stats(), { tags: 0, edges: 0, facts: 2 });
});

test("re-adding a fact replaces its edges instead of stacking them", () => {
  const graph = new TagGraph();
  graph.addFact(1, ["a", "b"]);
  graph.addFact(1, ["a", "c"]);
  assert.deepEqual(graph.neighbors("a"), [{ tag: "c", weight: 1 }]);
  assert.deepEqual(graph.stats(), { tags: 2, edges: 1, facts: 1 });
});

test("removeFact drops the contribution and edge counts stay exact", () => {
  const graph = new TagGraph();
  graph.addFact(1, ["a", "b"]);
  graph.addFact(2, ["a", "b"]);
  assert.equal(graph.stats().edges, 1);

  graph.removeFact(1);
  assert.deepEqual(graph.neighbors("a"), [{ tag: "b", weight: 1 }]);
  assert.deepEqual(graph.stats(), { tags: 2, edges: 1, facts: 1 });

  graph.removeFact(2);
  assert.deepEqual(graph.stats(), { tags: 0, edges: 0, facts: 0 });
});

test("expand walks the graph with per-hop decay and skips seeds", () => {
  const graph = new TagGraph();
  // a-b (x2), b-c (x1): expanding from "a" reaches b at hop 1 and c at hop 2.
  graph.addFact(1, ["a", "b"]);
  graph.addFact(2, ["a", "b"]);
  graph.addFact(3, ["b", "c"]);

  const oneHop = graph.expand(["a"], 1);
  assert.deepEqual([...oneHop.entries()], [["b", 2]]);

  const twoHop = graph.expand(["a"], 2);
  assert.equal(twoHop.get("b"), 2);
  assert.equal(twoHop.get("c"), 0.5, "second hop weight is halved");
  assert.equal(twoHop.has("a"), false, "seed tags are excluded");
});

test("clear empties the graph", () => {
  const graph = new TagGraph();
  graph.addFact(1, ["a", "b"]);
  graph.clear();
  assert.deepEqual(graph.stats(), { tags: 0, edges: 0, facts: 0 });
  assert.deepEqual(graph.neighbors("a"), []);
});
