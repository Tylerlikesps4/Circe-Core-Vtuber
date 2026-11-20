import type { ChatMessage } from "./stream.js";

/**
 * Open-ended goal pursuit and multi-turn planning for the ambient co-host.
 * Goals are declarative: a description the brain can pursue in character,
 * a deterministic satisfaction check against the live scene, an optional
 * hint, and an optional sequence of sub-steps (a multi-turn plan) that
 * guides Circe turn-by-turn through an arc without breaking character.
 */

export interface GoalContext {
  chat: ChatMessage[];
  now: number;
}

export interface GoalStep {
  /** Concise description of this sub-step */
  description: string;
  /** Optional tactical guidance for the brain during this step */
  tactic?: string;
  /** Optional deterministic satisfaction check for this step */
  check?: (ctx: GoalContext) => boolean;
}

export interface Goal {
  /** Stable id, e.g. "chat-moving". */
  id: string;
  /** What Circe should make happen, written for her (goes into her prompt). */
  description: string;
  /** Deterministic check: is this entire goal satisfied by the current scene? */
  check: (ctx: GoalContext) => boolean;
  /** Optional tactic to whisper into the brain prompt while active. */
  hint?: string;
  /**
   * Ordered sub-steps that break this goal into a multi-turn plan.
   * Can be strings or GoalStep objects.
   */
  steps?: (string | GoalStep)[];
  /**
   * Maximum turns to spend on a single sub-step before automatically
   * advancing to the next sub-step (default: 3; 0 to disable auto-advance).
   */
  maxTurnsPerStep?: number;
}

export interface ActiveGoalStatus {
  id: string;
  description: string;
  hint?: string;
  steps: GoalStep[];
  stepIndex: number;
  currentStep: GoalStep | null;
  turnsOnStep: number;
  totalSteps: number;
}

export interface GoalStatus {
  active: ActiveGoalStatus | null;
  pending: Goal[];
  done: number;
}

export interface StepChange {
  step: GoalStep;
  previous?: GoalStep;
  index: number;
  totalSteps: number;
  reason?: string;
}

export interface GoalChange {
  activated?: Goal;
  completed?: Goal;
  stepAdvanced?: StepChange;
}

export interface StepAdvanceResult {
  advanced: boolean;
  step?: GoalStep;
  previous?: GoalStep;
  index: number;
  totalSteps: number;
  reason?: string;
}

export interface TurnRecordResult {
  autoAdvanced: boolean;
  step?: GoalStep;
  previous?: GoalStep;
  index: number;
  totalSteps: number;
  reason?: string;
}

export function normalizeStep(step: string | GoalStep): GoalStep {
  if (typeof step === "string") {
    return { description: step.trim() };
  }
  return {
    description: step.description.trim(),
    tactic: step.tactic?.trim(),
    check: step.check,
  };
}

/** Built-in goal: at least `minMessages` chat lines within `windowMs`. */
export function goalChatVolume(
  id: string,
  minMessages: number,
  windowMs = 3_600_000,
  steps?: (string | GoalStep)[],
): Goal {
  return {
    id,
    description: `get the chat moving — at least ${minMessages} messages in the last ${Math.round(windowMs / 60_000)} minutes`,
    hint: "Ask chat a direct question, tease a topic, or bait a reaction.",
    steps: steps ?? [
      {
        description: "Hook chat with a provocative question or forbidden potion riddle",
        tactic: "Bait an initial reaction.",
      },
      {
        description: "Respond playfully to the earliest chatter and ask a follow-up",
        tactic: "Turn a single reply into a back-and-forth.",
      },
      {
        description: "Challenge the whole chat to weigh in before the timer expires",
        tactic: "Create urgency and invite lurkers to speak up.",
      },
    ],
    check: (ctx) =>
      ctx.chat.filter((m) => ctx.now - m.ts <= windowMs).length >= minMessages,
  };
}

/** Built-in goal: at least `minChatters` distinct chatters within `windowMs`. */
export function goalDistinctChatters(
  id: string,
  minChatters: number,
  windowMs = 3_600_000,
  steps?: (string | GoalStep)[],
): Goal {
  return {
    id,
    description: `draw in at least ${minChatters} different chatters within the last ${Math.round(windowMs / 60_000)} minutes`,
    hint: "Call chatters by name and invite lurkers to say hello.",
    steps: steps ?? [
      {
        description: "Notice the quiet room and wonder aloud where the lurkers are hiding",
        tactic: "Acknowledge the silence playfully without sounding desperate.",
      },
      {
        description: "Offer a personalized cyber-sorcery potion to anyone who speaks",
        tactic: "Give a direct incentive for quiet viewers to drop a line.",
      },
      {
        description: "Call out recent or lingering viewers warmly by name",
        tactic: "Make each individual feel seen and welcomed.",
      },
    ],
    check: (ctx) => {
      const users = new Set(
        ctx.chat.filter((m) => ctx.now - m.ts <= windowMs).map((m) => m.user),
      );
      return users.size >= minChatters;
    },
  };
}

export function parseBulletSteps(text: string, maxSteps = 4): GoalStep[] {
  const steps: GoalStep[] = [];
  const lines = text.split("\n");
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("```") || line.endsWith(":")) continue;
    const stripped = line
      .replace(/^[-*•]\s*/, "")
      .replace(/^\d+[.)]\s*/, "")
      .replace(/^step\s*\d+\s*[:\-]\s*/i, "")
      .trim();
    if (!stripped || stripped.length < 4) continue;
    const match = stripped.match(/^(.*?)(?:\s*\((?:Tactic|Hint):\s*(.*?)\))?$/i);
    const description = (match ? match[1] : stripped).trim();
    const tactic = match && match[2] ? match[2].trim() : undefined;
    if (
      description &&
      !steps.some((s) => s.description.toLowerCase() === description.toLowerCase())
    ) {
      steps.push({ description, tactic });
      if (steps.length >= maxSteps) break;
    }
  }
  return steps;
}

export function fallbackPlan(goal: Goal): GoalStep[] {
  return [
    {
      description: `Hook the audience and tease the premise behind ${goal.description}`,
      tactic: goal.hint ?? "Ask an intriguing question or introduce an interactive riddle.",
    },
    {
      description: "Directly engage respondents, challenge quiet viewers, and build momentum",
      tactic: "Call out lurkers playfully and turn replies into a back-and-forth.",
    },
    {
      description: "Deliver the climax or reward chat with a payoff",
      tactic: "Acknowledge active chatters and wrap up the beat.",
    },
  ];
}

/**
 * Break an active or pending goal into a multi-turn sequence of in-character sub-steps
 * using the brain, falling back deterministically if the brain fails or is omitted.
 */
export async function planGoal(
  brain:
    | { execute: (messages: { role: string; content: string }[]) => Promise<string> }
    | null
    | undefined,
  goal: Goal,
  options: { maxSteps?: number } = {},
): Promise<GoalStep[]> {
  const maxSteps = options.maxSteps ?? 3;
  if (!brain) return fallbackPlan(goal).slice(0, maxSteps);
  try {
    const raw = await brain.execute([
      {
        role: "system",
        content:
          "You are a strategic stream director for Circe, an ancient cyber-sorceress VTuber. " +
          "Your job is to break a stream goal into 2 to 4 concise, sequential in-character sub-steps for her " +
          "to execute across consecutive chat turns. Keep each step under 20 words. Format as bullet points.",
      },
      {
        role: "user",
        content: `Goal: "${goal.description}"\n${goal.hint ? `Overall tactic: "${goal.hint}"` : ""}`,
      },
    ]);
    const parsed = parseBulletSteps(raw, maxSteps);
    if (parsed.length > 0) return parsed;
  } catch {
    // Brain failure falls back deterministically
  }
  return fallbackPlan(goal).slice(0, maxSteps);
}

function safeCheck(
  fn: ((ctx: GoalContext) => boolean) | undefined,
  ctx: GoalContext,
): boolean {
  if (!fn) return false;
  try {
    return Boolean(fn(ctx));
  } catch {
    return false;
  }
}

/**
 * Tracks a queue of goals and their multi-turn sub-step plans for the session.
 * Goals are attempted in order. A satisfied goal retires (once per session) and
 * the next pending one activates. While active, the tracker maintains current sub-step
 * progress across brain turns.
 */
export class GoalTracker {
  private readonly goals: Goal[];
  private readonly doneIds = new Set<string>();
  private readonly stepsMap = new Map<string, GoalStep[]>();
  private activeId: string | null = null;
  private currentStepIndex = 0;
  private stepTurns = 0;

  constructor(goals: Goal[] = []) {
    this.goals = goals;
    for (const goal of goals) {
      if (goal.steps && goal.steps.length > 0) {
        this.stepsMap.set(goal.id, goal.steps.map(normalizeStep));
      }
    }
  }

  /** The goal Circe is currently pursuing, if any. */
  active(): Goal | null {
    if (!this.activeId) return null;
    return this.goals.find((goal) => goal.id === this.activeId) ?? null;
  }

  /** Sub-steps configured for the active goal, if any. */
  activeSteps(): GoalStep[] {
    if (!this.activeId) return [];
    return this.stepsMap.get(this.activeId) ?? [];
  }

  /** Active sub-step currently in focus. */
  activeStep(): GoalStep | null {
    const steps = this.activeSteps();
    if (steps.length === 0) return null;
    return steps[this.currentStepIndex] ?? null;
  }

  /** Index of the active sub-step (0-based). */
  activeStepIndex(): number {
    return this.currentStepIndex;
  }

  /** Set or replace sub-steps for a specific goal. */
  setSteps(goalId: string, steps: (string | GoalStep)[]): void {
    this.stepsMap.set(goalId, steps.map(normalizeStep));
    if (this.activeId === goalId) {
      this.currentStepIndex = 0;
      this.stepTurns = 0;
    }
  }

  /** Advance to the next sub-step in the active goal's plan. */
  advanceStep(reason?: string): StepAdvanceResult {
    const steps = this.activeSteps();
    const totalSteps = steps.length;
    if (totalSteps === 0) {
      return { advanced: false, index: 0, totalSteps: 0, reason };
    }
    if (this.currentStepIndex < totalSteps - 1) {
      const previous = steps[this.currentStepIndex];
      this.currentStepIndex += 1;
      this.stepTurns = 0;
      return {
        advanced: true,
        step: steps[this.currentStepIndex],
        previous,
        index: this.currentStepIndex,
        totalSteps,
        reason,
      };
    }
    return {
      advanced: false,
      step: steps[this.currentStepIndex],
      index: this.currentStepIndex,
      totalSteps,
      reason,
    };
  }

  /**
   * Record a brain turn completed on the active goal. Auto-advances the step
   * if `maxTurnsPerStep` is reached and subsequent steps remain.
   */
  recordTurn(): TurnRecordResult {
    const activeGoal = this.active();
    if (!activeGoal) return { autoAdvanced: false, index: 0, totalSteps: 0 };
    const steps = this.activeSteps();
    const totalSteps = steps.length;
    if (totalSteps === 0) return { autoAdvanced: false, index: 0, totalSteps: 0 };

    this.stepTurns += 1;
    const maxTurns = activeGoal.maxTurnsPerStep ?? 3;
    if (maxTurns > 0 && this.stepTurns >= maxTurns && this.currentStepIndex < totalSteps - 1) {
      const adv = this.advanceStep("turns-exceeded");
      if (adv.advanced) {
        return {
          autoAdvanced: true,
          step: adv.step,
          previous: adv.previous,
          index: adv.index,
          totalSteps: adv.totalSteps,
          reason: "turns-exceeded",
        };
      }
    }
    return {
      autoAdvanced: false,
      step: steps[this.currentStepIndex],
      index: this.currentStepIndex,
      totalSteps,
    };
  }

  /** Full session status: active goal with its plan, remaining queue, completions. */
  status(): GoalStatus {
    const activeGoal = this.active();
    const steps = this.activeSteps();
    const activeStatus: ActiveGoalStatus | null = activeGoal
      ? {
          id: activeGoal.id,
          description: activeGoal.description,
          hint: activeGoal.hint,
          steps,
          stepIndex: this.currentStepIndex,
          currentStep: steps[this.currentStepIndex] ?? null,
          turnsOnStep: this.stepTurns,
          totalSteps: steps.length,
        }
      : null;

    return {
      active: activeStatus,
      pending: this.goals.filter(
        (goal) => goal.id !== this.activeId && !this.doneIds.has(goal.id),
      ),
      done: this.doneIds.size,
    };
  }

  /**
   * Re-evaluate against the live scene: retire a satisfied active goal,
   * advance a step if its deterministic check passed, or activate the next pending goal.
   * Returns what changed so callers can emit events.
   */
  evaluate(ctx: GoalContext): GoalChange {
    const change: GoalChange = {};
    const active = this.active();
    if (active && safeCheck(active.check, ctx)) {
      this.doneIds.add(active.id);
      this.activeId = null;
      this.currentStepIndex = 0;
      this.stepTurns = 0;
      change.completed = active;
    } else if (active) {
      const step = this.activeStep();
      const steps = this.activeSteps();
      if (step?.check && safeCheck(step.check, ctx) && this.currentStepIndex < steps.length - 1) {
        const adv = this.advanceStep("check-passed");
        if (adv.advanced) {
          change.stepAdvanced = {
            step: adv.step!,
            previous: adv.previous,
            index: adv.index,
            totalSteps: adv.totalSteps,
            reason: "check-passed",
          };
        }
      }
    }

    if (!this.activeId) {
      const next = this.goals.find(
        (goal) => !this.doneIds.has(goal.id) && !safeCheck(goal.check, ctx),
      );
      if (next) {
        this.activeId = next.id;
        this.currentStepIndex = 0;
        this.stepTurns = 0;
        change.activated = next;
      }
    }
    return change;
  }

  /** Prompt block for the active goal and its multi-turn plan (empty string when none). */
  prompt(): string {
    const active = this.active();
    if (!active) return "";
    const lines = ["[CURRENT GOAL]", active.description];
    const steps = this.activeSteps();

    if (steps.length > 0) {
      lines.push("Plan:");
      steps.forEach((step, idx) => {
        const marker =
          idx < this.currentStepIndex
            ? "[done]"
            : idx === this.currentStepIndex
              ? "[active]"
              : "[pending]";
        const tacticNote =
          step.tactic && idx === this.currentStepIndex ? ` (Tactic: ${step.tactic})` : "";
        lines.push(`  ${marker} Step ${idx + 1}: ${step.description}${tacticNote}`);
      });
      const current = steps[this.currentStepIndex];
      if (current) {
        lines.push(`Current focus: Step ${this.currentStepIndex + 1} — ${current.description}.`);
        if (current.tactic) lines.push(`Step tactic: ${current.tactic}`);
      }
    } else if (active.hint) {
      lines.push(`Tactic: ${active.hint}`);
    }
    lines.push("Pursue it in character, naturally, without mentioning the goal or plan itself.");
    return lines.join("\n");
  }
}
