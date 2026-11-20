import { test } from "node:test";
import assert from "node:assert/strict";
import { CirceBrain } from "../brain.js";
import { CirceRuntime } from "../runtime.js";
import { EmotionTracker, type EmotionState } from "../emotion.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("emotion tracker starts neutral and renders an empty prompt", () => {
  const tracker = new EmotionTracker();
  const initial = tracker.get();
  assert.equal(initial.mood, "neutral");
  assert.equal(initial.intensity, 0);
  assert.equal(tracker.toPrompt(), "");
});

test("observeReply folds the latest cue mood and intensity into the state", () => {
  const tracker = new EmotionTracker();
  const state = tracker.observeReply("*giggles* Oh, you know I like it.");
  assert.equal(state.mood, "playful");
  assert.ok(state.intensity > 0, "a giggling cue carries intensity");
  assert.equal(state.since > 0, true);

  const sigh = tracker.observeReply("*sighs* Give my mana reserves a moment.");
  assert.equal(sigh.mood, "deadpan");
});

test("observeReply holds the state when the reply has no cues", () => {
  const tracker = new EmotionTracker();
  tracker.set("playful", 0.7);
  const held = tracker.observeReply("Just a plain line with no markers.");
  assert.equal(held.mood, "playful");
  assert.ok(Math.abs(held.intensity - 0.7) < 1e-9);
});

test("observe folds a cue into the state and set() overrides it", () => {
  const tracker = new EmotionTracker();
  tracker.observe({
    marker: "giggles",
    kind: "vocal",
    expression: "joy",
    mood: "playful",
    intensity: 0.8,
  });
  assert.equal(tracker.get().mood, "playful");

  const manual: EmotionState = tracker.set("mischievous", 0.9);
  assert.equal(manual.mood, "mischievous");
  assert.ok(Math.abs(manual.intensity - 0.9) < 1e-9);
});

test("cueWeight scales cue intensity", () => {
  const tracker = new EmotionTracker({ cueWeight: 0.5 });
  const state = tracker.observeReply("*giggles* Hello, piglets.");
  assert.equal(state.mood, "playful");
  assert.ok(Math.abs(state.intensity - 0.4) < 1e-9, `expected scaled intensity, got ${state.intensity}`);
});

test("emotion renders into the brain prompt when set", () => {
  const tracker = new EmotionTracker();
  tracker.set("mischievous", 0.85);
  const prompt = tracker.toPrompt();
  assert.match(prompt, /\[EMOTION\]/);
  assert.match(prompt, /Mood: mischievous/);
});
