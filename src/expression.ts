export type CueKind = "vocal" | "gesture";

export interface AnimationCue {
  /** Raw text inside the asterisks, e.g. "giggles" or "tilts head...". */
  marker: string;
  kind: CueKind;
  /** Canonical expression key for the VTuber model, e.g. "joy", "pout", "smug". */
  expression: string;
  /** Broad emotional register, e.g. "playful", "mischievous", "deadpan". */
  mood: string;
  /** 0..1 drive strength for the animation layer. */
  intensity: number;
  /** Estimated position of the cue within the spoken reply, ms from speech start. */
  atMs?: number;
}

export interface ParsedReply {
  /** Reply text with every *marker* removed — safe to send to TTS. */
  speech: string;
  cues: AnimationCue[];
}

export interface ParseOptions {
  /** Speaking rate used to estimate cue positions along the reply timeline. */
  wpm?: number;
}

const DEFAULT_WPM = 155;
const MS_PER_WORD = (wpm: number) => (60_000 / wpm);

interface VocalDef {
  expression: string;
  mood: string;
  intensity: number;
}

const VOCAL: Record<string, VocalDef> = {
  giggle: { expression: "joy", mood: "playful", intensity: 0.8 },
  giggles: { expression: "joy", mood: "playful", intensity: 0.8 },
  laugh: { expression: "joy", mood: "playful", intensity: 0.9 },
  laughs: { expression: "joy", mood: "playful", intensity: 0.9 },
  chuckle: { expression: "joy", mood: "playful", intensity: 0.7 },
  chuckles: { expression: "joy", mood: "playful", intensity: 0.7 },
  pout: { expression: "pout", mood: "playful", intensity: 0.7 },
  pouts: { expression: "pout", mood: "playful", intensity: 0.7 },
  smug: { expression: "smug", mood: "mischievous", intensity: 0.8 },
  smugs: { expression: "smug", mood: "mischievous", intensity: 0.8 },
  smirk: { expression: "smug", mood: "mischievous", intensity: 0.7 },
  smirks: { expression: "smug", mood: "mischievous", intensity: 0.7 },
  sigh: { expression: "tired", mood: "deadpan", intensity: 0.5 },
  sighs: { expression: "tired", mood: "deadpan", intensity: 0.5 },
  gasp: { expression: "surprised", mood: "surprised", intensity: 0.9 },
  gasps: { expression: "surprised", mood: "surprised", intensity: 0.9 },
  hum: { expression: "thoughtful", mood: "calm", intensity: 0.4 },
  hums: { expression: "thoughtful", mood: "calm", intensity: 0.4 },
  yawn: { expression: "tired", mood: "sleepy", intensity: 0.6 },
  yawns: { expression: "tired", mood: "sleepy", intensity: 0.6 },
};

const MARKER_RE = /\*([^*]+)\*/g;

function inferMood(marker: string): string {
  const t = marker.toLowerCase();
  if (/(smile|grin|mischiev|tease|wink|smirk)/.test(t)) return "playful";
  if (/(lean|tilt|step|reach|raise|gesture)/.test(t)) return "attentive";
  if (/(wave|bow|nod|point)/.test(t)) return "warm";
  if (/(sigh|tired|slump|rub|yawn)/.test(t)) return "deadpan";
  if (/(shake|frown|narrow|glare|pout)/.test(t)) return "displeased";
  return "neutral";
}

/**
 * Classify one marker (text inside asterisks) into an animation cue: known
 * vocalizations map to their expression, anything else becomes a gesture
 * with an inferred mood.
 */
export function classifyMarker(marker: string): AnimationCue {
  const key = marker.toLowerCase();
  const vocal = VOCAL[key];
  if (vocal) return { marker, kind: "vocal", ...vocal };
  return {
    marker,
    kind: "gesture",
    expression: "gesture",
    mood: inferMood(marker),
    intensity: 0.6,
  };
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Split a Circe reply into (a) the spoken text for TTS and (b) a list of
 * animation cues derived from her `*asterisk*` markers. Each cue carries
 * `atMs`, its estimated position along the speech timeline.
 */
export function parseReply(reply: string, options: ParseOptions = {}): ParsedReply {
  if (typeof reply !== "string") return { speech: "", cues: [] };
  const wpm = options.wpm ?? DEFAULT_WPM;
  const cues: AnimationCue[] = [];
  let speech = "";
  let cursor = 0;
  let wordsSpoken = 0;
  for (const match of reply.matchAll(MARKER_RE)) {
    const index = match.index ?? 0;
    const before = reply.slice(cursor, index);
    speech += before;
    wordsSpoken += countWords(before);
    const marker = match[1].trim();
    if (marker) {
      cues.push({ ...classifyMarker(marker), atMs: Math.round(wordsSpoken * MS_PER_WORD(wpm)) });
    }
    cursor = index + match[0].length;
  }
  speech += reply.slice(cursor);
  speech = speech.replace(/[ \t]{2,}/g, " ").trim();
  return { speech, cues };
}
