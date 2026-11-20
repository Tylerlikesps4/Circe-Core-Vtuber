import { parseReply } from "./expression.js";
import type { AnimationCue } from "./expression.js";

/**
 * Circe's evolving emotional state: the broad mood register and intensity
 * derived from her own vocal/gesture cues (or set directly). Fed into the brain
 * as an `[EMOTION]` prompt block so replies can track how she has been feeling.
 */
export interface EmotionState {
  /** Broad emotional register, e.g. "playful", "mischievous", "deadpan". */
  mood: string;
  /** 0..1 drive strength of the current emotional moment. */
  intensity: number;
  /** Epoch ms of the last observation. */
  since: number;
}

export interface EmotionOptions {
  /** How strongly a single cue can move the state (default 0.8, clamped 0..1). */
  cueWeight?: number;
}

const DEFAULT_CUE_WEIGHT = 0.8;

/**
 * Tracks Circe's current emotional state from her own expression cues and
 * replies, and renders it as a prompt block for the brain.
 */
export class EmotionTracker {
  private mood = "neutral";
  private intensity = 0;
  private since = Date.now();
  private readonly cueWeight: number;

  constructor(options: EmotionOptions = {}) {
    this.cueWeight = options.cueWeight ?? DEFAULT_CUE_WEIGHT;
  }

  /** Fold one animation cue (vocal or gesture) into the emotion state. */
  observe(cue: AnimationCue): EmotionState {
    this.mood = cue.mood;
    this.intensity = Math.min(1, Math.max(0, cue.intensity * this.cueWeight));
    this.since = Date.now();
    return this.get();
  }

  /** Fold the latest emotional cue of a reply into the emotion state. */
  observeReply(reply: string): EmotionState {
    const { cues } = parseReply(reply);
    const last = cues[cues.length - 1];
    if (!last) {
      // No emotional markers: hold the current state rather than inventing one.
      return this.get();
    }
    this.mood = last.mood;
    this.intensity = Math.min(1, Math.max(0, last.intensity * this.cueWeight));
    this.since = Date.now();
    return this.get();
  }

  /** Set the emotion state directly (used by overlays, tests, and future planners). */
  set(mood: string, intensity = 1): EmotionState {
    this.mood = mood;
    this.intensity = Math.min(1, Math.max(0, intensity));
    this.since = Date.now();
    return this.get();
  }

  /** Current emotion state. */
  get(): EmotionState {
    return { mood: this.mood, intensity: this.intensity, since: this.since };
  }

  /** Render the current emotion as a brain-prompt block; empty when neutral. */
  toPrompt(): string {
    if (this.intensity <= 0 || this.mood === "neutral") return "";
    return [`[EMOTION]`, `Mood: ${this.mood} (intensity ${this.intensity.toFixed(2)})`].join("\n");
  }
}
