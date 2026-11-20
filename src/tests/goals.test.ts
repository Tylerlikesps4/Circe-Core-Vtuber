import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GoalTracker,
  goalChatVolume,
  goalDistinctChatters,
  GoalContext,
  normalizeStep,
  parseBulletSteps,
  fallbackPlan,
  planGoal,
} from "../goals.js";

function ctx(chat: { user: string; message: string; ts: number }[], now = 1_000_000): GoalContext {
  return { chat, now };
}

test("activates the first pending goal and retires it once satisfied", () => {
  const tracker = new GoalTracker([
    { id: "g1", description: "first", check: (c) => c.chat.length >= 2 },
    { id: "g2", description: "second", check: (c) => c.chat.length >= 5 },
  ]);

  const first = tracker.evaluate(ctx([]));
  assert.equal(first.activated?.id, "g1");
  assert.equal(tracker.active()?.id, "g1");
  assert.equal(tracker.status().pending.length, 1);

  // Still unsatisfied: nothing changes.
  const still = tracker.evaluate(ctx([{ user: "a", message: "hi", ts: 1 }]));
  assert.deepEqual(still, {});

  const done = tracker.evaluate(
    ctx([
      { user: "a", message: "hi", ts: 1 },
      { user: "b", message: "yo", ts: 2 },
    ]),
  );
  assert.equal(done.completed?.id, "g1");
  assert.equal(done.activated?.id, "g2", "next goal activates in the same evaluation");
  assert.equal(tracker.status().done, 1);
  assert.equal(tracker.status().pending.length, 0);
});

test("completed goals never reactivate within a session", () => {
  const tracker = new GoalTracker([
    { id: "once", description: "once", check: (c) => c.chat.length >= 1 },
  ]);
  tracker.evaluate(ctx([{ user: "a", message: "hi", ts: 1 }]));
  assert.equal(tracker.active(), null);
  const again = tracker.evaluate(ctx([{ user: "a", message: "hi", ts: 1 }]));
  assert.deepEqual(again, {});
});

test("prompt renders the active goal with a tactic line", () => {
  const tracker = new GoalTracker([
    {
      id: "chat-moving",
      description: "get the chat moving",
      hint: "Ask a question.",
      check: () => false,
    },
  ]);
  tracker.evaluate(ctx([]));
  const prompt = tracker.prompt();
  assert.match(prompt, /\[CURRENT GOAL\]/);
  assert.match(prompt, /get the chat moving/);
  assert.match(prompt, /Tactic: Ask a question\./);

  const empty = new GoalTracker([]);
  assert.equal(empty.prompt(), "");
});

test("goalChatVolume counts recent messages within the window", () => {
  const goal = goalChatVolume("v", 2, 1000);
  const now = 10_000;
  assert.equal(goal.check(ctx([{ user: "a", message: "1", ts: now - 500 }], now)), false);
  assert.equal(
    goal.check(
      ctx(
        [
          { user: "a", message: "1", ts: now - 500 },
          { user: "b", message: "2", ts: now - 100 },
        ],
        now,
      ),
    ),
    true,
  );
  // Old messages outside the window do not count.
  assert.equal(
    goal.check(
      ctx(
        [
          { user: "a", message: "1", ts: now - 500 },
          { user: "b", message: "2", ts: now - 2000 },
        ],
        now,
      ),
    ),
    false,
  );
});

test("goalDistinctChatters counts unique chatters", () => {
  const goal = goalDistinctChatters("d", 3, 1000);
  const now = 10_000;
  assert.equal(
    goal.check(
      ctx(
        [
          { user: "a", message: "1", ts: now - 500 },
          { user: "a", message: "2", ts: now - 400 },
          { user: "b", message: "3", ts: now - 300 },
        ],
        now,
      ),
    ),
    false,
  );
  assert.equal(
    goal.check(
      ctx(
        [
          { user: "a", message: "1", ts: now - 500 },
          { user: "b", message: "2", ts: now - 400 },
          { user: "c", message: "3", ts: now - 300 },
        ],
        now,
      ),
    ),
    true,
  );
});

test("normalizeStep handles strings and objects", () => {
  assert.deepEqual(normalizeStep("Hook chat with a riddle"), {
    description: "Hook chat with a riddle",
  });
  assert.deepEqual(
    normalizeStep({ description: " Step 1 ", tactic: " Direct question " }),
    { description: "Step 1", tactic: "Direct question", check: undefined },
  );
});

test("parseBulletSteps extracts structured steps and tactics", () => {
  const text = [
    "Here is the plan:",
    "- Tease the cauldron experiment (Tactic: ask about ingredients)",
    "* Challenge the quietest viewer to pick a vial",
    "3. Reward the chatter with a cyber-blessing",
    "```",
  ].join("\n");
  const steps = parseBulletSteps(text);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].description, "Tease the cauldron experiment");
  assert.equal(steps[0].tactic, "ask about ingredients");
  assert.equal(steps[1].description, "Challenge the quietest viewer to pick a vial");
  assert.equal(steps[2].description, "Reward the chatter with a cyber-blessing");
});

test("fallbackPlan creates three in-character steps", () => {
  const plan = fallbackPlan({
    id: "g",
    description: "test goal",
    hint: "Use magic",
    check: () => false,
  });
  assert.equal(plan.length, 3);
  assert.match(plan[0].description, /Hook the audience/);
  assert.equal(plan[0].tactic, "Use magic");
  assert.match(plan[1].description, /Directly engage/);
  assert.match(plan[2].description, /Deliver the climax/);
});

test("planGoal uses the brain and caps steps, falling back on failure", async () => {
  const mockBrain = {
    execute: async () =>
      "- Step 1: Speak softly\n- Step 2: Speak loudly\n- Step 3: Cast spell\n- Step 4: Bow",
  };
  const steps = await planGoal(
    mockBrain,
    { id: "g", description: "test", check: () => false },
    { maxSteps: 2 },
  );
  assert.equal(steps.length, 2);
  assert.equal(steps[0].description, "Speak softly");
  assert.equal(steps[1].description, "Speak loudly");

  const failingBrain = {
    execute: async () => {
      throw new Error("offline");
    },
  };
  const fallback = await planGoal(failingBrain, {
    id: "g",
    description: "test",
    check: () => false,
  });
  assert.equal(fallback.length, 3);
  assert.match(fallback[0].description, /Hook/);

  const noBrain = await planGoal(null, { id: "g", description: "test", check: () => false });
  assert.equal(noBrain.length, 3);
});

test("GoalTracker tracks sub-steps and renders multi-turn prompt", () => {
  const tracker = new GoalTracker([
    {
      id: "arc",
      description: "tell a story arc",
      steps: [
        { description: "Introduce the forgotten shrine", tactic: "Whisper mysteriously" },
        { description: "Ask chat to pick the left or right door" },
        { description: "Reveal the cyber-relic" },
      ],
      check: () => false,
    },
  ]);
  tracker.evaluate(ctx([]));
  const status = tracker.status();
  assert.ok(status.active);
  assert.equal(status.active.steps.length, 3);
  assert.equal(status.active.stepIndex, 0);
  assert.equal(status.active.currentStep?.description, "Introduce the forgotten shrine");

  const p1 = tracker.prompt();
  assert.match(p1, /\[CURRENT GOAL\]/);
  assert.match(p1, /Plan:/);
  assert.match(p1, /\[active\] Step 1: Introduce the forgotten shrine \(Tactic: Whisper mysteriously\)/);
  assert.match(p1, /\[pending\] Step 2: Ask chat to pick the left or right door/);
  assert.match(p1, /Current focus: Step 1 — Introduce the forgotten shrine\./);

  // Advance step
  const adv = tracker.advanceStep("scene hook established");
  assert.equal(adv.advanced, true);
  assert.equal(adv.index, 1);
  assert.equal(tracker.status().active?.stepIndex, 1);
  assert.equal(tracker.status().active?.currentStep?.description, "Ask chat to pick the left or right door");

  const p2 = tracker.prompt();
  assert.match(p2, /\[done\] Step 1: Introduce the forgotten shrine/);
  assert.match(p2, /\[active\] Step 2: Ask chat to pick the left or right door/);
  assert.match(p2, /\[pending\] Step 3: Reveal the cyber-relic/);

  // Advance to final step
  tracker.advanceStep();
  assert.equal(tracker.status().active?.stepIndex, 2);
  // Cannot advance beyond the end
  const pastEnd = tracker.advanceStep();
  assert.equal(pastEnd.advanced, false);
  assert.equal(tracker.status().active?.stepIndex, 2);
});

test("recordTurn auto-advances step when maxTurnsPerStep is reached", () => {
  const tracker = new GoalTracker([
    {
      id: "arc",
      description: "test turns",
      maxTurnsPerStep: 2,
      steps: ["Step One", "Step Two", "Step Three"],
      check: () => false,
    },
  ]);
  tracker.evaluate(ctx([]));
  assert.equal(tracker.status().active?.stepIndex, 0);

  const t1 = tracker.recordTurn();
  assert.equal(t1.autoAdvanced, false);
  assert.equal(tracker.status().active?.stepIndex, 0);

  const t2 = tracker.recordTurn();
  assert.equal(t2.autoAdvanced, true);
  assert.equal(t2.index, 1);
  assert.equal(tracker.status().active?.stepIndex, 1);
  assert.equal(tracker.status().active?.currentStep?.description, "Step Two");
});

test("evaluate auto-advances step when step.check passes", () => {
  const tracker = new GoalTracker([
    {
      id: "g",
      description: "check steps",
      steps: [
        {
          description: "Get at least 1 message",
          check: (c) => c.chat.length >= 1,
        },
        {
          description: "Get at least 3 messages",
          check: (c) => c.chat.length >= 3,
        },
      ],
      check: (c) => c.chat.length >= 5,
    },
  ]);
  tracker.evaluate(ctx([]));
  assert.equal(tracker.status().active?.stepIndex, 0);

  const change = tracker.evaluate(ctx([{ user: "a", message: "hi", ts: 100 }]));
  assert.ok(change.stepAdvanced);
  assert.equal(change.stepAdvanced.index, 1);
  assert.equal(tracker.status().active?.stepIndex, 1);
});

test("setSteps dynamically replaces steps and resets active step index", () => {
  const tracker = new GoalTracker([
    {
      id: "dynamic",
      description: "dynamic goal",
      steps: ["Old step 1", "Old step 2"],
      check: () => false,
    },
  ]);
  tracker.evaluate(ctx([]));
  tracker.advanceStep();
  assert.equal(tracker.status().active?.stepIndex, 1);

  tracker.setSteps("dynamic", ["New 1", "New 2", "New 3"]);
  assert.equal(tracker.status().active?.steps.length, 3);
  assert.equal(tracker.status().active?.stepIndex, 0);
  assert.equal(tracker.status().active?.currentStep?.description, "New 1");
});
