import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ViewerTier = "newcomer" | "regular" | "vip" | "heckler";

export interface ViewerProfile {
  user: string;
  firstSeen: number;
  lastSeen: number;
  messageCount: number;
  /** Affinity score clamped between -100 (hostile) and +100 (devoted); neutral is 0. */
  affinity: number;
  tier: ViewerTier;
  notes: string[];
  /** Optional persona id override when replying to this viewer. */
  personaId?: string;
}

export interface ViewerRegistryOptions {
  /** Optional JSONL file for persisting viewer profiles across sessions. */
  file?: string;
  /** Messages required to graduate from newcomer to regular (default: 5). */
  regularThreshold?: number;
  /** Max viewer profiles kept in memory (default: 1000). */
  maxViewers?: number;
}

export function normalizeUser(user: string): string {
  if (typeof user !== "string") return "";
  return user.trim().toLowerCase().replace(/^@/, "");
}

export function computeTier(
  messageCount: number,
  affinity: number,
  explicitTier?: ViewerTier,
  regularThreshold = 5,
): ViewerTier {
  if (explicitTier === "vip") return "vip";
  if (affinity <= -20) return "heckler";
  if (explicitTier && explicitTier !== "newcomer" && explicitTier !== "regular") {
    return explicitTier;
  }
  if (messageCount >= regularThreshold) return "regular";
  return "newcomer";
}

export class ViewerRegistry {
  private readonly profiles = new Map<string, ViewerProfile>();
  private readonly file?: string;
  private readonly regularThreshold: number;
  private readonly maxViewers: number;

  constructor(options: ViewerRegistryOptions = {}) {
    this.file = options.file;
    this.regularThreshold = options.regularThreshold ?? 5;
    this.maxViewers = options.maxViewers ?? 1000;
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        this.load();
      } catch {
        // file reading is best-effort
      }
    }
  }

  get(user: string): ViewerProfile | null {
    const key = normalizeUser(user);
    if (!key) return null;
    return this.profiles.get(key) ?? null;
  }

  getOrCreate(user: string): ViewerProfile {
    const key = normalizeUser(user) || "anon";
    const existing = this.profiles.get(key);
    if (existing) return existing;

    const now = Date.now();
    const created: ViewerProfile = {
      user: key,
      firstSeen: now,
      lastSeen: now,
      messageCount: 0,
      affinity: 0,
      tier: "newcomer",
      notes: [],
    };
    this.profiles.set(key, created);
    this.prune();
    this.persist();
    return created;
  }

  /** Record a chat message sent by a viewer. Updates activity counters and tier. */
  recordMessage(user: string, _message?: string): ViewerProfile {
    const profile = this.getOrCreate(user);
    profile.lastSeen = Date.now();
    profile.messageCount += 1;
    profile.tier = computeTier(
      profile.messageCount,
      profile.affinity,
      profile.tier,
      this.regularThreshold,
    );
    this.persist();
    return profile;
  }

  /** Adjust viewer affinity by delta (clamped to [-100, 100]). Updates tier accordingly. */
  adjustAffinity(user: string, delta: number, _reason?: string): ViewerProfile {
    const profile = this.getOrCreate(user);
    const num = Number.isFinite(delta) ? delta : 0;
    profile.affinity = Math.max(-100, Math.min(100, Math.round(profile.affinity + num)));
    profile.tier = computeTier(
      profile.messageCount,
      profile.affinity,
      profile.tier,
      this.regularThreshold,
    );
    this.persist();
    return profile;
  }

  /** Attach a concise observation note about this viewer. */
  addNote(user: string, note: string): ViewerProfile {
    const profile = this.getOrCreate(user);
    const trimmed = note.trim();
    if (trimmed && !profile.notes.some((n) => n.toLowerCase() === trimmed.toLowerCase())) {
      profile.notes.push(trimmed);
      if (profile.notes.length > 10) profile.notes.shift();
      this.persist();
    }
    return profile;
  }

  /** Explicitly assign a tier (e.g. promoting to VIP or demoting to heckler). */
  setTier(user: string, tier: ViewerTier): ViewerProfile {
    const profile = this.getOrCreate(user);
    profile.tier = tier;
    this.persist();
    return profile;
  }

  /** Assign a custom persona override for replies to this viewer. */
  setPersona(user: string, personaId?: string): ViewerProfile {
    const profile = this.getOrCreate(user);
    profile.personaId = personaId?.trim() || undefined;
    this.persist();
    return profile;
  }

  /** List all tracked viewer profiles with optional filtering and sorting. */
  all(
    options: {
      tier?: ViewerTier;
      sort?: "messages" | "affinity" | "lastSeen";
      limit?: number;
    } = {},
  ): ViewerProfile[] {
    let list = [...this.profiles.values()];
    if (options.tier) {
      list = list.filter((p) => p.tier === options.tier);
    }
    const sort = options.sort ?? "lastSeen";
    list.sort((a, b) => {
      if (sort === "messages") return b.messageCount - a.messageCount;
      if (sort === "affinity") return b.affinity - a.affinity;
      return b.lastSeen - a.lastSeen;
    });
    if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
      list = list.slice(0, Math.max(0, options.limit));
    }
    return list;
  }

  /** Render an in-character prompt block tailored to this viewer for Circe's prompt. */
  renderPrompt(user: string): string {
    const profile = this.get(user);
    if (!profile) return "";
    const sign = profile.affinity > 0 ? `+${profile.affinity}` : `${profile.affinity}`;
    const lines = [
      `[VIEWER CONTEXT: ${profile.user}]`,
      `Relationship: ${profile.tier} · ${profile.messageCount} messages · Affinity: ${sign}`,
    ];

    if (profile.tier === "heckler") {
      lines.push("Guidance: Treat with razor-sharp wit and dismissive sarcasm. Do not let them ruffle you.");
    } else if (profile.tier === "vip") {
      lines.push("Guidance: Treat with royal favor, acknowledge their loyalty, and prioritize their requests.");
    } else if (profile.tier === "regular") {
      lines.push("Guidance: Banter as a familiar acquaintance; reciprocate their warmth.");
    } else {
      lines.push("Guidance: Welcome them gently into the stream; explain the rituals playfully.");
    }

    if (profile.notes.length > 0) {
      lines.push(`Notes: ${profile.notes.join("; ")}`);
    }
    return lines.join("\n");
  }

  private prune(): void {
    if (this.profiles.size <= this.maxViewers) return;
    const sorted = [...this.profiles.values()].sort((a, b) => a.lastSeen - b.lastSeen);
    const toRemove = sorted.slice(0, this.profiles.size - this.maxViewers);
    for (const p of toRemove) {
      this.profiles.delete(p.user);
    }
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = readFileSync(this.file, "utf8");
      const lines = raw.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as ViewerProfile;
          if (parsed && typeof parsed.user === "string") {
            const key = normalizeUser(parsed.user);
            this.profiles.set(key, {
              user: key,
              firstSeen: typeof parsed.firstSeen === "number" ? parsed.firstSeen : Date.now(),
              lastSeen: typeof parsed.lastSeen === "number" ? parsed.lastSeen : Date.now(),
              messageCount: typeof parsed.messageCount === "number" ? parsed.messageCount : 0,
              affinity: typeof parsed.affinity === "number" ? parsed.affinity : 0,
              tier:
                parsed.tier === "vip" ||
                parsed.tier === "heckler" ||
                parsed.tier === "regular" ||
                parsed.tier === "newcomer"
                  ? parsed.tier
                  : "newcomer",
              notes: Array.isArray(parsed.notes)
                ? parsed.notes.filter((n): n is string => typeof n === "string")
                : [],
              personaId: typeof parsed.personaId === "string" ? parsed.personaId : undefined,
            });
          }
        } catch {
          // ignore corrupted lines
        }
      }
    } catch {
      // missing file is normal on first start
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      const lines = [...this.profiles.values()].map((p) => JSON.stringify(p)).join("\n");
      writeFileSync(this.file, lines + (lines ? "\n" : ""), "utf8");
    } catch {
      // persistence is best-effort
    }
  }
}
