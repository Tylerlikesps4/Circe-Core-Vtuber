import type { LlmMessage } from "./brain.js";
import type { Persona } from "./persona.js";

/**
 * Two-hander mode: Circe and a second persona (Evil Neuro by default) trade
 * lines on the same stream. Each turn is generated with that speaker's own
 * system prompt against a shared, attributed transcript, so the pair bicker
 * like co-hosts without either model believing it said the other's lines.
 */

/** The seam the duet needs from a brain: one raw completion, no history. */
export interface DuetBrain {
  execute(messages: LlmMessage[]): Promise<string>;
}

export interface DuetLine {
  /** Display name of the speaker (e.g. "Circe"). */
  speaker: string;
  personaId: string;
  text: string;
  ts: number;
}

export interface DuetOptions {
  /** Who opens; defaults to the primary persona. */
  opener?: "primary" | "partner";
  /** Total lines traded (default 4: two each). */
  turns?: number;
  /** Trim each line to roughly this many characters (default 400). */
  maxChars?: number;
  /** Per-line hook, awaited so callers can speak the line before the next. */
  onLine?: (line: DuetLine) => void | Promise<void>;
}

export interface DuetResult {
  topic: string;
  lines: DuetLine[];
  /** Set when a turn failed and the deterministic fallback line ran instead. */
  error?: string;
}

export interface DuetSpeakers {
  primary: Persona;
  partner: Persona;
}

const DEFAULT_TURNS = 4;
const DEFAULT_MAX_CHARS = 400;

/**
 * Cut a line at the last sentence boundary under `maxChars`, falling back to a
 * hard slice. Keeps spoken banter short without chopping mid-word.
 */
export function clampLine(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  const clean = text.trim().replace(/^["“]|["”]$/g, "").trim();
  if (clean.length <= maxChars) return clean;
  const window = clean.slice(0, maxChars);
  const boundary = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
    window.lastIndexOf("."),
    window.lastIndexOf("!"),
    window.lastIndexOf("?"),
  );
  if (boundary >= maxChars * 0.3) {
    const cut = clean.slice(0, boundary + 1).trim();
    if (cut) return cut;
  }
  return `${window.trim()}…`;
}

function renderTranscript(lines: DuetLine[]): string {
  return lines.map((line) => `${line.speaker}: ${line.text}`).join("\n");
}

function duetPrompt(speaker: Persona, other: Persona): string {
  return [
    speaker.systemPrompt,
    "",
    "[DUET]",
    `You are ${speaker.name}, co-hosting a live stream with ${other.name}.`,
    `The two of you are separate characters with separate voices: trade barbs, tease each other,`,
    `and react to what ${other.name} just said. Stay fully in character and never speak for`,
    `${other.name} or narrate their actions. One or two short spoken sentences, text-to-speech`,
    `friendly, with *asterisk* action markers where they fit.`,
  ].join("\n");
}

function turnPrompt(
  speaker: Persona,
  other: Persona,
  topic: string,
  lines: DuetLine[],
): string {
  if (lines.length === 0) {
    return (
      `Open the bit. The topic is: ${topic}. ` +
      `Say the first line as ${speaker.name}, addressing ${other.name}.`
    );
  }
  const last = lines[lines.length - 1];
  return [
    "Transcript so far:",
    renderTranscript(lines),
    "",
  ].join("\n") + `It's your line as ${speaker.name} — answer ${last.speaker}. Topic: ${topic}.`;
}

function fallbackLine(speaker: Persona, other: Persona): string {
  return speaker.id === "circe"
    ? `*taps the microphone* ...did ${other.name} break the model, or is it just me?`
    : `*snorts* Great. My co-host broke reality again. Figures.`;
}

/**
 * Run the duet: alternate speakers for `turns` lines, generating each against
 * the shared transcript. A failed turn falls back to an in-character one-liner
 * and stops the bit rather than looping on errors.
 */
export async function runDuet(
  brain: DuetBrain,
  speakers: DuetSpeakers,
  topic: string,
  options: DuetOptions,
): Promise<DuetResult> {
  const turns = Math.max(2, options.turns ?? DEFAULT_TURNS);
  const maxChars = Math.max(40, options.maxChars ?? DEFAULT_MAX_CHARS);
  const opener = options.opener ?? "primary";
  const lines: DuetLine[] = [];
  let error: string | undefined;

  for (let i = 0; i < turns; i++) {
    const primaryTurn = (i % 2 === 0) === (opener === "primary");
    const speaker = primaryTurn ? speakers.primary : speakers.partner;
    const other = primaryTurn ? speakers.partner : speakers.primary;
    let text: string;
    try {
      const reply = await brain.execute([
        { role: "system", content: duetPrompt(speaker, other) },
        { role: "user", content: turnPrompt(speaker, other, topic, lines) },
      ]);
      text = clampLine(reply, maxChars);
      if (!text) throw new Error("empty reply");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      text = clampLine(fallbackLine(speaker, other), maxChars);
    }

    const line: DuetLine = { speaker: speaker.name, personaId: speaker.id, text, ts: Date.now() };
    lines.push(line);
    await options.onLine?.(line);

    if (error) break;
  }

  return { topic, lines, ...(error ? { error } : {}) };
}
