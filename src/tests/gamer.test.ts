import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../bus.js";
import { CirceRuntime } from "../runtime.js";
import { DEFAULT_ACTIONS, Gamer, defaultPolicy, gameplayPrompt, parsePlan } from "../gamer.js";
import type { GamerObservation } from "../gamer.js";

const idle: GamerObservation = { game: {}, lastAction: null, history: [] };

test("defaultPolicy confirms menus, heals low health, and fights when engaged", () => {
  assert.equal(defaultPolicy({ ...idle, game: { menu: true } }).action.kind, "confirm");
  assert.equal(defaultPolicy({ ...idle, game: { paused: true } }).action.kind, "confirm");
  assert.equal(defaultPolicy({ ...idle, game: { health: 0.2 } }).action.kind, "heal");
  assert.equal(defaultPolicy({ ...idle, game: { hp: 15 } }).action.kind, "heal");

  const fight = defaultPolicy({ ...idle, game: { boss: "Malenia", health: 0.9 } });
  assert.equal(fight.action.kind, "attack");
  assert.equal(fight.action.input, "light");
  assert.match(fight.commentary ?? "", /\S/);
});

test("defaultPolicy explores in a rotating cycle when nothing is happening", () => {
  const first = defaultPolicy(idle);
  assert.equal(first.action.kind, "look");
  const second = defaultPolicy({ ...idle, lastAction: { kind: "look", ts: 1 } });
  assert.equal(second.action.kind, "move");
  const third = defaultPolicy({ ...idle, lastAction: { kind: "move", ts: 1 } });
  assert.equal(third.action.kind, "interact");
});

test("parsePlan tolerates fences, prose, and misses", () => {
  assert.deepEqual(parsePlan('{"action":"dodge","input":"roll"}'), {
    action: { kind: "dodge", input: "roll" },
  });
  const fenced = parsePlan('Sure!\n```json\n{"action":"Attack","commentary":"go"}\n```');
  assert.equal(fenced?.action.kind, "attack");
  assert.equal(fenced?.commentary, "go");
  assert.equal(parsePlan("no json here"), null);
  assert.equal(parsePlan('{"input":"x"}'), null);
  assert.equal(parsePlan('{"action":'), null);
});

test("tick is a dry run by default but still emits action and commentary", async () => {
  const bus = new EventBus();
  const events: Record<string, unknown>[] = [];
  bus.on((event) => events.push(event));
  let delivered = 0;
  const gamer = new Gamer(
    {
      getState: () => ({ boss: "Malenia" }),
      act: () => {
        delivered += 1;
        return true;
      },
    },
    bus,
  );

  const action = await gamer.tick();
  assert.equal(action?.kind, "attack");
  assert.equal(delivered, 0, "dry run never touches the game");
  assert.ok(events.some((e) => e.type === "game-action" && e.kind === "attack"));
  assert.ok(events.some((e) => e.type === "game-commentary" && typeof e.text === "string"));
  assert.equal(gamer.lastAction?.kind, "attack");
});

test("live mode delivers actions and reports delivery failures", async () => {
  const bus = new EventBus();
  const events: Record<string, unknown>[] = [];
  bus.on((event) => events.push(event));
  const seen: string[] = [];
  const gamer = new Gamer(
    {
      getState: () => ({ boss: "Malenia" }),
      live: true,
      act: (action) => {
        seen.push(action.kind);
        return action.kind !== "attack" ? true : false;
      },
    },
    bus,
  );

  await gamer.tick();
  assert.deepEqual(seen, ["attack"]);
  assert.ok(events.some((e) => e.type === "game-error" && /not delivered/.test(String(e.detail))));

  const throwing = new Gamer({
    getState: () => ({ boss: "Malenia" }),
    live: true,
    act: () => {
      throw new Error("keyboard bridge offline");
    },
  });
  assert.equal((await throwing.tick())?.kind, "attack");
});

test("tick skips empty scenes by default and runs when requireState is off", async () => {
  const gamer = new Gamer({ getState: () => null });
  assert.equal(await gamer.tick(), null);
  assert.equal(gamer.lastAction, null);

  const idleGamer = new Gamer({ getState: () => null, requireState: false });
  assert.equal((await idleGamer.tick())?.kind, "look");
});

test("brain policy drives the action and falls back deterministically", async () => {
  const bus = new EventBus();
  const events: Record<string, unknown>[] = [];
  bus.on((event) => events.push(event));

  const prompts: string[] = [];
  const smart = new Gamer(
    {
      getState: () => ({ boss: "Malenia" }),
      brain: {
        execute: async (messages) => {
          prompts.push(String(messages[0].content));
          return '{"action":"dodge","input":"backstep","commentary":"Not today."}';
        },
      },
    },
    bus,
  );
  const action = await smart.tick();
  assert.equal(action?.kind, "dodge");
  assert.equal(action?.input, "backstep");
  assert.match(prompts[0], /gameplay half/);
  assert.ok(events.some((e) => e.type === "game-commentary" && e.text === "Not today."));

  const broken = new Gamer(
    {
      getState: () => ({ health: 10 }),
      brain: {
        execute: async () => {
          throw new Error("model offline");
        },
      },
    },
    bus,
  );
  assert.equal((await broken.tick())?.kind, "heal", "falls back to the offline policy");
  assert.ok(events.some((e) => e.type === "game-error" && /model offline/.test(String(e.detail))));
});

test("disallowed actions are rejected and never reach the game", async () => {
  const bus = new EventBus();
  const events: Record<string, unknown>[] = [];
  bus.on((event) => events.push(event));
  const gamer = new Gamer(
    {
      getState: () => ({}),
      live: true,
      act: () => {
        throw new Error("should not run");
      },
      policy: () => ({ action: { kind: "delete-save" } }),
    },
    bus,
  );
  assert.equal(await gamer.tick(), null);
  assert.equal(gamer.recent().length, 0);
  assert.ok(events.some((e) => e.type === "game-error" && /disallowed action/.test(String(e.detail))));
  assert.ok(DEFAULT_ACTIONS.includes("attack"));
});

test("history is bounded and gameplayPrompt renders the recent intent", async () => {
  let n = 0;
  const gamer = new Gamer({
    getState: () => ({}),
    maxActions: 2,
    policy: () => ({ action: { kind: "look", note: `scan ${++n}` } }),
  });
  await gamer.tick();
  await gamer.tick();
  await gamer.tick();
  assert.equal(gamer.recent().length, 2);
  const prompt = gameplayPrompt(gamer, 2);
  assert.match(prompt, /^\[GAMEPLAY\]/);
  assert.match(prompt, /look — scan 3/);
  assert.match(prompt, /look — scan 2/);
  assert.doesNotMatch(prompt, /scan 1/);

  assert.equal(gameplayPrompt(new Gamer()), "");
});

test("start ticks on an interval and stop cancels", async () => {
  let ticks = 0;
  const gamer = new Gamer({
    getState: () => ({}),
    intervalMs: 200,
    policy: () => {
      ticks += 1;
      return { action: { kind: "look" } };
    },
  });
  gamer.start();
  assert.equal(gamer.running, true);
  await new Promise((resolve) => setTimeout(resolve, 460));
  gamer.stop();
  assert.equal(gamer.running, false);
  const seen = ticks;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(ticks, seen, "no ticks after stop");
  assert.ok(ticks >= 1, `expected at least one tick, got ${ticks}`);
});

test("runtime wires the gamer into the prompt, lifecycle, and /game/step", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-gamer-"));
  const runtime = new CirceRuntime({
    port: 0,
    logFile: join(dir, "events.jsonl"),
    gamer: {
      intervalMs: 60_000,
      policy: () => ({
        action: { kind: "attack", note: "punish the opening" },
        commentary: "There's the opening!",
      }),
    },
  });
  try {
    runtime.stream.setGame({ boss: "Malenia", health: 0.6 });
    const action = await runtime.gamer?.tick();
    assert.equal(action?.kind, "attack");

    const prompt = runtime.contextPrompt();
    assert.match(prompt, /Game: \{"boss":"Malenia"/);
    assert.match(prompt, /\[GAMEPLAY\]/);
    assert.match(prompt, /attack — punish the opening/);
    assert.match(prompt, /There's the opening!/);

    await runtime.start();
    assert.equal(runtime.gamer?.running, true);
    const res = await fetch(`http://127.0.0.1:${runtime.stream.port}/game/step`, { method: "POST" });
    const body = (await res.json()) as { ok: boolean; action?: { kind: string } };
    assert.equal(body.ok, true);
    assert.equal(body.action?.kind, "attack");

    await runtime.stop();
    assert.equal(runtime.gamer?.running, false);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
