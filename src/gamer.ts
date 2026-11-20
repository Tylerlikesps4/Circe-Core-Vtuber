import type { EventBus } from "./bus.js";
import type { LlmMessage } from "./brain.js";

/** A game snapshot as the gamer sees it: arbitrary fields, optional timestamp. */
export type GamerScene = Record<string, unknown> & { ts?: number };

/**
 * The talker + gamer tandem: a gameplay mind that observes the live game state
 * and picks the next input, separate from the conversational brain. The gamer
 * emits `game-action` (what it pressed) and `game-commentary` (why, in
 * character) events; the runtime folds both into Circe's prompt so she can
 * narrate her own play without the talker having to steer the game.
 */

/** One input handed to the game, plus the intent behind it. */
export interface GamerAction {
  kind: string;
  input?: string;
  /** Short in-character reason, e.g. "punish the recovery window". */
  note?: string;
  /** The reasoning line voiced by the talker, when the policy supplied one. */
  commentary?: string;
  ts: number;
}

export interface GamerObservation {
  game: GamerScene | null;
  lastAction: GamerAction | null;
  /** Previous `maxActions` actions, oldest first (excluding `lastAction`). */
  history: GamerAction[];
}

export interface GamerPlan {
  action: { kind: string; input?: string; note?: string };
  /** In-character commentary the talker may voice aloud; optional. */
  commentary?: string;
}

export type GamerPolicy = (observation: GamerObservation) => GamerPlan | Promise<GamerPlan>;

/** The seam the gamer needs from a brain: one raw completion. */
export interface GamerBrain {
  execute(messages: LlmMessage[]): Promise<string>;
}

export interface GamerOptions {
  /** Deterministic or custom policy; takes precedence over `brain`. */
  policy?: GamerPolicy;
  /** LLM-backed policy used when no explicit `policy` is set. */
  brain?: GamerBrain;
  /** Read the current game state (defaults to the runtime's stream context). */
  getState?: () => GamerScene | null;
  /** Tick interval while started, in ms (default 5000). */
  intervalMs?: number;
  /** Actions kept in the history ring (default 12). */
  maxActions?: number;
  /** Action kinds the policy may return (default `DEFAULT_ACTIONS`). */
  allowedActions?: string[];
  /**
   * Deliver an action to the game (keyboard bridge, stdin, HTTP). Actions are
   * only handed over when `live` is true — the default is a dry run.
   */
  act?: (action: GamerAction) => Promise<boolean> | boolean;
  /** Whether to actually execute actions (default false: observe and narrate only). */
  live?: boolean;
  /** Skip a tick when the scene has no game state (default true). */
  requireState?: boolean;
}

export const DEFAULT_ACTIONS = [
  "move",
  "look",
  "attack",
  "dodge",
  "heal",
  "use",
  "interact",
  "jump",
  "confirm",
  "wait",
];

const POLICY_PROMPT =
  "You are the gameplay half of a VTuber's split mind. Read the game state and the recent " +
  "action history, then choose exactly one next input. Reply with ONLY a JSON object shaped " +
  '{"action":"<kind>","input":"<optional detail>","commentary":"<short in-character line>"}. ' +
  "Stay in the middle of the difficulty band: aggressive when there is an opening, " +
  "defensive when health or resources are low. No markdown, no explanation.";

/** Read a numeric health-like field from arbitrary game state, normalized 0..1. */
function healthOf(state: GamerScene | null): number | null {
  if (!state) return null;
  for (const key of ["health", "hp", "Health", "HP"]) {
    const value = state[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1 ? value / 100 : value;
    }
  }
  return null;
}

/** True when the scene reads as an active fight. */
function inCombat(state: GamerScene | null): boolean {
  if (!state) return false;
  if (state.inCombat === true || state.combat === true) return true;
  return ["boss", "enemy", "enemies", "target"].some((key) => {
    const value = state[key];
    return value !== undefined && value !== null && value !== false && value !== "";
  });
}

/**
 * The offline policy: a small, deterministic combat loop so the tandem works
 * with no model attached. Menus get confirmed, low health heals, fights are
 * fought, and everything else explores.
 */
export function defaultPolicy(observation: GamerObservation): GamerPlan {
  const { game, lastAction } = observation;
  if (game) {
    const menu = game.menu ?? game.paused;
    if (menu === true || typeof menu === "string") {
      return {
        action: { kind: "confirm", note: "Clear the menu and get back to it." },
        commentary: "One second — dismissing this menu.",
      };
    }
    const health = healthOf(game);
    if (health !== null && health <= 0.3) {
      return {
        action: { kind: "heal", note: "Health is low; reset the fight." },
        commentary: "Nope, not dying to chip damage. Healing first.",
      };
    }
    if (inCombat(game)) {
      return {
        action: { kind: "attack", input: "light", note: "Punish the opening while it lasts." },
        commentary: "There's the opening — punish it!",
      };
    }
  }

  const cycle: GamerPlan[] = [
    { action: { kind: "look", note: "Scan for the next objective." }, commentary: "Where to next, I wonder." },
    { action: { kind: "move", input: "forward", note: "Press on toward the objective." } },
    { action: { kind: "interact", note: "Check whatever is nearby." } },
  ];
  const index = lastAction ? (cycle.findIndex((plan) => plan.action.kind === lastAction.kind) + 1) % cycle.length : 0;
  return cycle[index];
}

/** Pull the first JSON object out of a model reply, tolerating fences and prose. */
export function parsePlan(text: string): GamerPlan | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const kind = typeof data.action === "string" ? data.action.trim().toLowerCase() : "";
  if (!kind) return null;
  const input = typeof data.input === "string" ? data.input : undefined;
  const note = typeof data.note === "string" ? data.note : undefined;
  const commentary = typeof data.commentary === "string" ? data.commentary : undefined;
  return {
    action: { kind, ...(input ? { input } : {}), ...(note ? { note } : {}) },
    ...(commentary ? { commentary } : {}),
  };
}

/**
 * The gameplay loop. Each tick observes the scene, asks the policy (or the
 * brain) for one action, emits it on the bus, optionally delivers it to the
 * game, and keeps a short history so consecutive decisions stay coherent.
 */
export class Gamer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private history: GamerAction[] = [];
  private busy = false;
  private readonly options: GamerOptions;
  private readonly allowed: Set<string>;
  private readonly intervalMs: number;
  private readonly maxActions: number;

  constructor(
    options: GamerOptions = {},
    private readonly bus: EventBus | null = null,
  ) {
    this.options = options;
    this.allowed = new Set((options.allowedActions ?? DEFAULT_ACTIONS).map((a) => a.toLowerCase()));
    this.intervalMs = Math.max(200, options.intervalMs ?? 5000);
    this.maxActions = Math.max(1, options.maxActions ?? 12);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** The most recent action, or null before the first tick. */
  get lastAction(): GamerAction | null {
    return this.history.length ? this.history[this.history.length - 1] : null;
  }

  /** Recent actions, oldest first. */
  recent(): GamerAction[] {
    return [...this.history];
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One observe → decide → act pass. Returns the action taken, or null when
   * the scene has no state (and `requireState` is on) or a tick is mid-flight.
   */
  async tick(): Promise<GamerAction | null> {
    if (this.busy) return null;
    const game = this.options.getState ? this.options.getState() : null;
    if (!game && (this.options.requireState ?? true)) return null;

    this.busy = true;
    try {
      const plan = await this.decide({ game, lastAction: this.lastAction, history: this.recent() });
      const kind = plan.action.kind.trim().toLowerCase();
      if (!this.allowed.has(kind)) {
        this.bus?.emit("game-error", { detail: `policy returned disallowed action: ${kind}` });
        return null;
      }
      const action: GamerAction = {
        kind,
        ...(plan.action.input ? { input: plan.action.input } : {}),
        ...(plan.action.note ? { note: plan.action.note } : {}),
        ...(plan.commentary ? { commentary: plan.commentary } : {}),
        ts: Date.now(),
      };

      this.history.push(action);
      while (this.history.length > this.maxActions) this.history.shift();
      this.bus?.emit("game-action", { ...action });

      if (plan.commentary) {
        this.bus?.emit("game-commentary", { text: plan.commentary, action: kind, ts: action.ts });
      }

      if (this.options.live && this.options.act) {
        try {
          const delivered = await this.options.act(action);
          if (!delivered) this.bus?.emit("game-error", { detail: `action not delivered: ${kind}` });
        } catch (err) {
          this.bus?.emit("game-error", { detail: `action failed: ${(err as Error).message}` });
        }
      }
      return action;
    } finally {
      this.busy = false;
    }
  }

  private async decide(observation: GamerObservation): Promise<GamerPlan> {
    if (this.options.policy) return this.options.policy(observation);
    const brain = this.options.brain;
    if (!brain) return defaultPolicy(observation);

    const messages: LlmMessage[] = [
      { role: "system", content: POLICY_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          game: observation.game,
          lastAction: observation.lastAction,
          recent: observation.history.slice(-5),
          allowedActions: [...this.allowed],
        }),
      },
    ];
    try {
      const reply = await brain.execute(messages);
      const plan = parsePlan(reply);
      if (plan && this.allowed.has(plan.action.kind.trim().toLowerCase())) return plan;
      this.bus?.emit("game-error", { detail: "brain policy returned no usable plan" });
    } catch (err) {
      this.bus?.emit("game-error", { detail: `brain policy failed: ${(err as Error).message}` });
    }
    return defaultPolicy(observation);
  }
}

/**
 * Render the gameplay mind as a prompt block for the talker: current state,
 * last input, and recent reasoning lines she may voice aloud.
 */
export function gameplayPrompt(gamer: Gamer, limit = 3): string {
  const actions = gamer.recent();
  if (actions.length === 0) return "";
  const lines = ["[GAMEPLAY]", "Circe is playing. Her hands and her commentary are hers:"];
  for (const action of actions.slice(-limit)) {
    const input = action.input ? ` (${action.input})` : "";
    const line = `- ${action.kind}${input}${action.note ? ` — ${action.note}` : ""}`;
    lines.push(action.commentary ? `${line} — "${action.commentary}"` : line);
  }
  return lines.join("\n");
}
