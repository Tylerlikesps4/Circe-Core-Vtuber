import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TagGraph, TagGraphStats, TagNeighbor } from "./graph.js";

export interface MemoryFact {
  id: number;
  text: string;
  tags: string[];
  createdAt: number;
  lastUsedAt: number | null;
  uses: number;
}

export interface MemoryOptions {
  /** JSONL file that persists facts across restarts. */
  file?: string;
  /** Maximum facts kept in memory; oldest are dropped beyond this (default 500). */
  maxFacts?: number;
  /**
   * Tag co-occurrence graph: lets `graphRecall()` surface facts related to
   * the query through shared tags even without keyword overlap (default true).
   */
  graph?: boolean;
  /** How many tag hops `graphRecall()` traverses from the seed tags (default 1). */
  graphHops?: number;
}

/** A graph-assisted recall hit: the fact plus which related tags pulled it in. */
export interface GraphMemoryResult {
  fact: MemoryFact;
  /** Related tags that connected this fact to the query (empty for direct hits). */
  via: string[];
}

interface MemoryRecord {
  id?: number;
  text?: unknown;
  tags?: unknown;
  createdAt?: unknown;
  lastUsedAt?: unknown;
  uses?: unknown;
}

function tokenize(text: string): Set<string> {
  if (typeof text !== "string") return new Set();
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3),
  );
}

function normalizeTags(tags: string[]): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const clean = tag.trim().toLowerCase();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
}

/**
 * Circe's long-term episodic memory: tagged facts she can recall across
 * sessions. Recall scores keyword overlap, tag hits, recency, and reuse, so
 * relevant and recently touched facts surface first without any embedding
 * model. Persists as JSONL; every add/forget rewrites only when trimming or
 * removing, otherwise appends.
 */
export class EpisodicMemory {
  private facts: MemoryFact[] = [];
  private nextId = 1;
  private readonly file?: string;
  private readonly maxFacts: number;
  private readonly graph: TagGraph;
  private readonly graphEnabled: boolean;
  private readonly hops: number;

  constructor(options: MemoryOptions = {}) {
    this.file = options.file;
    this.maxFacts = Math.max(1, options.maxFacts ?? 500);
    this.graphEnabled = options.graph ?? true;
    this.hops = Math.max(1, options.graphHops ?? 1);
    this.graph = new TagGraph();
    if (this.file) this.load(this.file);
  }

  /** Store a fact; identical text (case-insensitive) merges tags instead of duplicating. */
  remember(text: string, tags: string[] = []): MemoryFact {
    const clean = text.trim();
    if (!clean) throw new Error("memory fact text cannot be empty");
    const normalized = normalizeTags(tags);

    const existing = this.facts.find(
      (fact) => fact.text.toLowerCase() === clean.toLowerCase(),
    );
    if (existing) {
      existing.tags = normalizeTags([...existing.tags, ...normalized]);
      this.graph.addFact(existing.id, existing.tags);
      this.persistAll();
      return { ...existing, tags: [...existing.tags] };
    }

    const fact: MemoryFact = {
      id: this.nextId++,
      text: clean,
      tags: normalized,
      createdAt: Date.now(),
      lastUsedAt: null,
      uses: 0,
    };
    this.facts.push(fact);
    this.graph.addFact(fact.id, fact.tags);
    this.trim();
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        appendFileSync(this.file, JSON.stringify(fact) + "\n");
      } catch {
        // persistence is best-effort
      }
    }
    return { ...fact, tags: [...fact.tags] };
  }

  /** Ranked recall for a query; bumps use counters on the returned facts. */
  recall(query: string, limit = 5): MemoryFact[] {
    if (limit <= 0) return [];
    const picked = this.score(query).slice(0, limit).map((entry) => entry.fact);
    return picked.map((fact) => this.bump(fact));
  }

  /** Score all facts for a query: keyword/tag weight plus recency and reuse. */
  private score(query: string): { fact: MemoryFact; score: number; matched: boolean }[] {
    const safeQuery = typeof query === "string" ? query : String(query ?? "");
    const q = tokenize(safeQuery);
    const queryLower = safeQuery.toLowerCase();
    const now = Date.now();
    return this.facts
      .map((fact) => {
        let score = 0;
        let matched = false;
        if (q.size > 0) {
          const factTokens = tokenize(`${fact.text} ${fact.tags.join(" ")}`);
          for (const token of q) {
            if (factTokens.has(token)) {
              score += 2;
              matched = true;
            }
          }
          for (const tag of fact.tags) {
            if (queryLower.includes(tag)) {
              score += 3;
              matched = true;
            }
          }
        }
        const ageDays = (now - fact.createdAt) / 86_400_000;
        score += 1 / (1 + ageDays);
        score += Math.min(fact.uses, 5) * 0.1;
        return { fact, score, matched };
      })
      .sort((a, b) => b.score - a.score || b.fact.createdAt - a.fact.createdAt);
  }

  /** Mark a fact as used and return a defensive copy. */
  private bump(fact: MemoryFact): MemoryFact {
    fact.uses += 1;
    fact.lastUsedAt = Date.now();
    return { ...fact, tags: [...fact.tags] };
  }

  forget(id: number): boolean {
    const index = this.facts.findIndex((fact) => fact.id === id);
    if (index === -1) return false;
    this.graph.removeFact(this.facts[index].id);
    this.facts.splice(index, 1);
    this.persistAll();
    return true;
  }

  /**
   * Graph-assisted recall: keyword/tag-matched hits first, then facts pulled
   * in through tags that co-occur with the hits' tags (up to `hops` away).
   * Each result carries `via`, the related tags that connected it. Facts
   * that only score on recency never take a direct slot, leaving room for
   * the graph to fill the limit with genuinely related facts.
   */
  graphRecall(query: string, limit = 5): GraphMemoryResult[] {
    const scored = this.score(query);
    const matched = scored.filter((entry) => entry.matched);
    if (matched.length === 0) return [];

    const direct = matched.slice(0, limit);
    const results: GraphMemoryResult[] = direct.map((entry) => ({
      fact: this.bump(entry.fact),
      via: [],
    }));
    if (!this.graphEnabled || results.length >= limit) return results;

    const seedTags = new Set<string>();
    for (const entry of direct) {
      for (const tag of entry.fact.tags) seedTags.add(tag);
    }
    const related = this.graph.expand([...seedTags], this.hops);
    // Facts carrying a seed tag itself are related too (plain recall misses
    // them when the query never names the tag); score them above 1-hop hits.
    for (const tag of seedTags) related.set(tag, Math.max(related.get(tag) ?? 0, 2));
    if (related.size === 0) return results;

    const seen = new Set(direct.map((entry) => entry.fact.id));
    const candidates: { fact: MemoryFact; score: number; via: string[] }[] = [];
    for (const entry of scored) {
      const fact = entry.fact;
      if (seen.has(fact.id)) continue;
      let score = 0;
      const via: string[] = [];
      for (const tag of fact.tags) {
        const weight = related.get(tag);
        if (weight !== undefined) {
          score += weight;
          via.push(tag);
        }
      }
      if (score > 0) {
        candidates.push({ fact, score, via: via.sort() });
      }
    }
    candidates.sort((a, b) => b.score - a.score || b.fact.createdAt - a.fact.createdAt);
    for (const entry of candidates.slice(0, limit - direct.length)) {
      results.push({ fact: this.bump(entry.fact), via: [...entry.via] });
    }
    return results;
  }

  /** Tags most often seen together with `tag`, strongest first. */
  relatedTags(tag: string, limit = 10): TagNeighbor[] {
    if (!this.graphEnabled) return [];
    return this.graph.neighbors(tag).slice(0, Math.max(0, limit));
  }

  /** Size/shape of the co-occurrence graph (tags, edges, facts). */
  graphStats(): TagGraphStats {
    return this.graph.stats();
  }

  all(): MemoryFact[] {
    return this.facts.map((fact) => ({ ...fact, tags: [...fact.tags] }));
  }

  get size(): number {
    return this.facts.length;
  }

  /** Render recalled facts as a prompt block; empty string when nothing matches. */
  render(query = "", limit = 5): string {
    const facts = this.recall(query, limit);
    if (facts.length === 0) return "";
    const lines = ["[EPISODIC MEMORY]"];
    for (const fact of facts) {
      const tags = fact.tags.length > 0 ? ` (${fact.tags.join(", ")})` : "";
      lines.push(`- ${fact.text}${tags}`);
    }
    return lines.join("\n");
  }

  /** Like `render()`, but graph-assisted and annotated with `via` tags. */
  renderGraph(query = "", limit = 5): string {
    const results = this.graphRecall(query, limit);
    if (results.length === 0) return "";
    const lines = ["[EPISODIC MEMORY]"];
    for (const { fact, via } of results) {
      const tags = fact.tags.length > 0 ? ` (${fact.tags.join(", ")})` : "";
      const viaNote = via.length > 0 ? ` [via: ${via.join(", ")}]` : "";
      lines.push(`- ${fact.text}${tags}${viaNote}`);
    }
    return lines.join("\n");
  }

  private trim(): void {
    if (this.facts.length <= this.maxFacts) return;
    const ordered = [...this.facts].sort(
      (a, b) => a.createdAt - b.createdAt || a.id - b.id,
    );
    const keep = new Set(ordered.slice(-this.maxFacts).map((fact) => fact.id));
    this.facts = this.facts.filter((fact) => keep.has(fact.id));
    this.rebuildGraph();
    this.persistAll();
  }

  private rebuildGraph(): void {
    this.graph.clear();
    for (const fact of this.facts) this.graph.addFact(fact.id, fact.tags);
  }

  private persistAll(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        this.file,
        this.facts.map((fact) => JSON.stringify(fact)).join("\n") +
          (this.facts.length > 0 ? "\n" : ""),
      );
    } catch {
      // persistence is best-effort
    }
  }

  private load(file: string): void {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return;
    }
    let loaded = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as MemoryRecord;
        if (typeof record.text !== "string" || !record.text.trim()) continue;
        const tags = Array.isArray(record.tags)
          ? record.tags.filter((tag): tag is string => typeof tag === "string")
          : [];
        const id = typeof record.id === "number" ? record.id : this.nextId;
        this.facts.push({
          id,
          text: record.text.trim(),
          tags: normalizeTags(tags),
          createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
          lastUsedAt: typeof record.lastUsedAt === "number" ? record.lastUsedAt : null,
          uses: typeof record.uses === "number" ? record.uses : 0,
        });
        this.nextId = Math.max(this.nextId, id + 1);
        loaded += 1;
      } catch {
        // skip corrupt lines rather than losing everything
      }
    }
    if (loaded > this.maxFacts) {
      this.facts.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
      this.facts = this.facts.slice(-this.maxFacts);
      this.persistAll();
    }
    this.rebuildGraph();
  }
}
