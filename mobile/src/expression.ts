// Mirror of ../../src/expression.ts (parseReply / classifyMarker), trimmed for the phone.
export interface Cue {
  marker: string;
  kind: "vocal" | "gesture";
  expression: string;
  mood: string;
  intensity: number;
}

type Def = { expression: string; mood: string; intensity: number };
const V: Record<string, Def> = {};
const add = (words: string[], d: Def) => words.forEach((w) => (V[w] = d));
add(["giggle", "giggles"], { expression: "joy", mood: "playful", intensity: 0.8 });
add(["laugh", "laughs"], { expression: "joy", mood: "playful", intensity: 0.9 });
add(["chuckle", "chuckles"], { expression: "joy", mood: "playful", intensity: 0.7 });
add(["pout", "pouts"], { expression: "pout", mood: "playful", intensity: 0.7 });
add(["smug", "smugs"], { expression: "smug", mood: "mischievous", intensity: 0.8 });
add(["smirk", "smirks"], { expression: "smug", mood: "mischievous", intensity: 0.7 });
add(["sigh", "sighs"], { expression: "tired", mood: "deadpan", intensity: 0.5 });
add(["gasp", "gasps"], { expression: "surprised", mood: "surprised", intensity: 0.9 });
add(["hum", "hums"], { expression: "thoughtful", mood: "calm", intensity: 0.4 });
add(["yawn", "yawns"], { expression: "tired", mood: "sleepy", intensity: 0.6 });

function inferMood(marker: string): string {
  const t = marker.toLowerCase();
  if (/(smile|grin|mischiev|tease|wink|smirk)/.test(t)) return "playful";
  if (/(lean|tilt|step|reach|raise|gesture)/.test(t)) return "attentive";
  if (/(wave|bow|nod|point)/.test(t)) return "warm";
  if (/(sigh|tired|slump|rub|yawn)/.test(t)) return "deadpan";
  if (/(shake|frown|narrow|glare|pout)/.test(t)) return "displeased";
  return "neutral";
}

export function classifyMarker(marker: string): Cue {
  const v = V[marker.toLowerCase()];
  if (v) return { marker, kind: "vocal", ...v };
  return { marker, kind: "gesture", expression: "gesture", mood: inferMood(marker), intensity: 0.6 };
}

/** Split a reply into TTS-safe speech and *marker* cues. */
export function parseReply(reply: string): { speech: string; cues: Cue[] } {
  const cues: Cue[] = [];
  const speech = reply
    .replace(/\*([^*]+)\*/g, (_m, inner: string) => {
      const marker = inner.trim();
      if (marker) cues.push(classifyMarker(marker));
      return "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { speech, cues };
}

/** Drop <think>…</think> blocks some local models (qwen3) emit. */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trimStart();
}
