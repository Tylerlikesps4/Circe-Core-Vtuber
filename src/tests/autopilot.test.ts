import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../bus.js";
import { Autopilot, AutopilotMessage } from "../autopilot.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Fired {
  prompt: string;
  messages: AutopilotMessage[];
}

function recorder() {
  const fired: Fired[] = [];
  const handler = async (prompt: string, messages: AutopilotMessage[]) => {
    fired.push({ prompt, messages });
  };
  return { fired, handler };
}

test("reacts immediately once the batch threshold is reached", async () => {
  const { fired, handler } = recorder();
  const autopilot = new Autopilot(new EventBus(), handler, {
    batch: 2,
    idleMs: 500,
    minGapMs: 0,
  });
  autopilot.start();

  autopilot.note("alice", "hello");
  await wait(20);
  assert.equal(fired.length, 0);

  autopilot.note("bob", "oink oink");
  await wait(20);
  assert.equal(fired.length, 1);
  assert.deepEqual(
    fired[0].messages.map((m) => m.user),
    ["alice", "bob"],
  );
  assert.match(fired[0].prompt, /alice: hello/);
  assert.match(fired[0].prompt, /bob: oink oink/);

  autopilot.stop();
});

test("reacts to a lone message after the idle window", async () => {
  const { fired, handler } = recorder();
  const autopilot = new Autopilot(new EventBus(), handler, {
    batch: 5,
    idleMs: 15,
    minGapMs: 0,
  });
  autopilot.start();

  autopilot.note("piglet", "circe?");
  await wait(50);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].messages.length, 1);

  autopilot.stop();
});

test("respects maxRepliesPerMinute and keeps the excess buffered", async () => {
  const { fired, handler } = recorder();
  const autopilot = new Autopilot(new EventBus(), handler, {
    batch: 1,
    idleMs: 5,
    minGapMs: 0,
    maxRepliesPerMinute: 2,
  });
  autopilot.start();

  autopilot.note("a", "one");
  await wait(20);
  autopilot.note("b", "two");
  await wait(20);
  autopilot.note("c", "three");
  await wait(40);

  assert.equal(fired.length, 2);
  assert.equal(autopilot.pending, 1);

  autopilot.stop();
});

test("skips ignored users", async () => {
  const { fired, handler } = recorder();
  const autopilot = new Autopilot(new EventBus(), handler, {
    batch: 1,
    idleMs: 5,
    minGapMs: 0,
    ignore: (user) => user.toLowerCase() === "circe",
  });
  autopilot.start();

  autopilot.note("Circe", "her own message");
  await wait(20);
  assert.equal(fired.length, 0);

  autopilot.note("alice", "hi");
  await wait(20);
  assert.equal(fired.length, 1);

  autopilot.stop();
});

test("stop() cancels scheduled reactions", async () => {
  const { fired, handler } = recorder();
  const autopilot = new Autopilot(new EventBus(), handler, {
    batch: 3,
    idleMs: 10,
    minGapMs: 0,
  });
  autopilot.start();
  autopilot.note("alice", "hello");
  autopilot.stop();

  await wait(30);
  assert.equal(fired.length, 0);
});

test("emits autopilot-error when the handler rejects", async () => {
  const bus = new EventBus();
  const errors: string[] = [];
  bus.on((event) => {
    if (event.type === "autopilot-error") errors.push(String(event.message));
  });
  const autopilot = new Autopilot(
    bus,
    async () => {
      throw new Error("brain exploded");
    },
    { batch: 1, idleMs: 5, minGapMs: 0 },
  );
  autopilot.start();
  autopilot.note("alice", "hello");
  await wait(20);

  assert.ok(errors.some((e) => e.includes("brain exploded")));
  autopilot.stop();
});
