import type { ChatMessage } from "./stream.js";
import type { CirceBrain, LlmMessage } from "./brain.js";

/**
 * Session recaps: distill a finished (or ongoing) session into a handful of
 * self-contained facts and fold them into episodic memory, so Circe can
 * remember "last stream" the next time she boots up.
 */

export interface SessionDigest {
  chat: ChatMessage[];
  /** Everything she said this session, oldest first. */
  replies: string[];
  goalsDone: number;
  startedAt: number;
  endedAt: number;
}

export interface RecapResult {
  facts: string[];
  summary: string;
  source: "brain" | "fallback";
  /** Set when the brain pass failed and the deterministic fallback ran instead. */
  error?: string;
}

/** Tag applied to every memory fact written by a recap. */
export const RECAP_TAG = "recap";

function durationMinutes(digest: SessionDigest): number {
  const diff = Number(digest.endedAt) - Number(digest.startedAt);
  if (!Number.isFinite(diff) || diff < 0) return 1;
  return Math.max(1, Math.round(diff / 60_000));
}

function topChatters(chat: ChatMessage[], limit = 3): { name: string; count: number }[] {
  if (!Array.isArray(chat)) return [];
  const counts = new Map<string, number>();
  for (const message of chat) {
    if (!message || typeof message.user !== "string") continue;
    counts.set(message.user, (counts.get(message.user) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Deterministic, brain-free recap: session stats, top chatters, her last
 * words, and goal completions. Always succeeds.
 */
export function fallbackRecap(digest: SessionDigest): RecapResult {
  const facts: string[] = [];
  const cleanChat = Array.isArray(digest.chat)
    ? digest.chat.filter((m) => m && typeof m.user === "string")
    : [];
  const chatters = topChatters(cleanChat);
  const chatterCount = new Set(cleanChat.map((m) => m.user)).size;

  facts.push(
    `Previous session ran about ${durationMinutes(digest)} minutes with ${cleanChat.length} chat messages from ${chatterCount} chatters.`,
  );
  if (chatters.length > 0) {
    const names = chatters.map((c) => `${c.name} (${c.count})`).join(", ");
    facts.push(`Most active chatters last session: ${names}.`);
  }
  const replies = Array.isArray(digest.replies)
    ? digest.replies.filter((r): r is string => typeof r === "string")
    : [];
  const lastReply = replies[replies.length - 1];
  if (lastReply) {
    facts.push(`Circe spoke ${replies.length} times; her last words were: "${truncate(lastReply, 140)}"`);
  }
  if (digest.goalsDone > 0) {
    facts.push(`She completed ${digest.goalsDone} of her session goals.`);
  }
  return { facts, summary: facts[0] ?? "", source: "fallback" };
}

/** Extract facts from an archivist reply: bullet or numbered lines, deduped. */
export function parseBulletFacts(text: string): string[] {
  const seen = new Set<string>();
  const facts: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw
      .trim()
      .replace(/^[-*•]\s*/, "")
      .replace(/^\d+[.)]\s*/, "")
      .trim();
    if (!line) continue;
    if (line.startsWith("```") || line.endsWith(":")) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    facts.push(line);
  }
  return facts;
}

function buildTranscript(digest: SessionDigest): string {
  const lines: string[] = [
    `Session length: ~${durationMinutes(digest)} minutes. Completed goals: ${digest.goalsDone}.`,
  ];
  const chat = digest.chat.slice(-20);
  if (chat.length > 0) {
    lines.push("Chat:");
    for (const message of chat) lines.push(`- ${message.user}: ${message.message}`);
  }
  const replies = digest.replies.slice(-10);
  if (replies.length > 0) {
    lines.push("Circe said:");
    for (const reply of replies) lines.push(`- ${reply}`);
  }
  if (chat.length === 0 && replies.length === 0) lines.push("(no activity)");
  return lines.join("\n");
}

function archivistPrompt(maxFacts: number): string {
  return (
    "You are the session archivist for Circe-Core, an AI VTuber. Distill the session below " +
    `into at most ${maxFacts} short memories worth recalling next stream. Put each on its own ` +
    'line starting with "- ". Each memory must be self-contained, specific (viewer names, games, ' +
    "events, running jokes, promises Circe made), and written in third person. " +
    "No headers, no commentary, no markdown."
  );
}

/**
 * Distill the session with the brain (falling back to deterministic stats on
 * any failure). Returns facts ready to be stored in episodic memory.
 */
export async function sessionRecap(
  brain: CirceBrain | null,
  digest: SessionDigest,
  maxFacts = 5,
): Promise<RecapResult> {
  if (!brain) return fallbackRecap(digest);
  try {
    const messages: LlmMessage[] = [
      { role: "system", content: archivistPrompt(maxFacts) },
      { role: "user", content: buildTranscript(digest) },
    ];
    const facts = parseBulletFacts(await brain.execute(messages)).slice(0, maxFacts);
    if (facts.length === 0) {
      return { ...fallbackRecap(digest), error: "archivist returned no facts" };
    }
    return { facts, summary: facts[0], source: "brain" };
  } catch (err) {
    return { ...fallbackRecap(digest), error: (err as Error).message };
  }
}
