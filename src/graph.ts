/**
 * Tag co-occurrence graph over episodic memory. Tags are nodes; two tags are
 * connected when they appear together on the same fact, weighted by how often
 * they co-occur. Recall expands seed tags through the graph so a query can
 * surface related facts that share no keywords with it ("elden-ring" reaches
 * a fact tagged "boss" through a shared "cheese" tag, for example).
 */

export interface TagNeighbor {
  tag: string;
  weight: number;
}

export interface TagGraphStats {
  tags: number;
  edges: number;
  facts: number;
}

export class TagGraph {
  private readonly edges = new Map<string, Map<string, number>>();
  private readonly factTags = new Map<number, string[]>();
  private edgeCount = 0;

  /** Add or update a fact's tags (re-adding the same id replaces its edges). */
  addFact(id: number, tags: string[]): void {
    const current = this.factTags.get(id);
    if (current) this.removeFact(id, current);
    const unique = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
    if (unique.length === 0) return;
    this.factTags.set(id, unique);
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        this.bump(unique[i], unique[j]);
      }
    }
  }

  /** Remove a fact's contribution; pass its tags to skip the id lookup. */
  removeFact(id: number, tags?: string[]): void {
    const current = tags ?? this.factTags.get(id);
    this.factTags.delete(id);
    if (!current) return;
    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        this.unbump(current[i], current[j]);
      }
    }
  }

  /** Tags most often seen together with `tag`, strongest first. */
  neighbors(tag: string): TagNeighbor[] {
    const map = this.edges.get(tag.trim().toLowerCase());
    if (!map) return [];
    return [...map.entries()]
      .map(([neighbor, weight]) => ({ tag: neighbor, weight }))
      .sort((a, b) => b.weight - a.weight || a.tag.localeCompare(b.tag));
  }

  /**
   * Breadth-first expansion from seed tags: returns related tags (excluding
   * the seeds) with scores that decay per hop (weight / hop).
   */
  expand(seedTags: string[], hops = 1): Map<string, number> {
    const scores = new Map<string, number>();
    const visited = new Set(seedTags.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
    let frontier = [...visited];
    for (let hop = 1; hop <= hops; hop++) {
      const nextFrontier: string[] = [];
      for (const tag of frontier) {
        for (const { tag: neighbor, weight } of this.neighbors(tag)) {
          if (visited.has(neighbor)) continue;
          scores.set(neighbor, weight / hop);
          visited.add(neighbor);
          nextFrontier.push(neighbor);
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }
    return scores;
  }

  stats(): TagGraphStats {
    return { tags: this.edges.size, edges: this.edgeCount, facts: this.factTags.size };
  }

  clear(): void {
    this.edges.clear();
    this.factTags.clear();
    this.edgeCount = 0;
  }

  private bump(a: string, b: string): void {
    const created = this.incrementOne(a, b, 1);
    this.incrementOne(b, a, 1);
    if (created) this.edgeCount++;
  }

  private unbump(a: string, b: string): void {
    const removed = this.incrementOne(a, b, -1);
    this.incrementOne(b, a, -1);
    if (removed) this.edgeCount--;
  }

  /**
   * Adjust the a→b weight, keeping the mirror edge in sync. Returns true
   * when this call created (0→n) or removed (n→0) the directed edge.
   */
  private incrementOne(a: string, b: string, delta: number): boolean {
    let map = this.edges.get(a);
    if (!map) {
      if (delta < 0) return false;
      map = new Map();
      this.edges.set(a, map);
    }
    const prev = map.get(b) ?? 0;
    const next = prev + delta;
    if (next <= 0) {
      map.delete(b);
      if (map.size === 0) this.edges.delete(a);
    } else {
      map.set(b, next);
    }
    return (prev === 0 && next > 0) || (prev > 0 && next <= 0);
  }
}
