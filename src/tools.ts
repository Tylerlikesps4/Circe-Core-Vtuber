/**
 * Strict JSON tool envelope for Circe's brain. Local models are not reliably
 * tool-calling machines, so instead of OpenAI function-calling we give the
 * model a small, rigid contract: to use a tool it must output a single JSON
 * object `{ "tool": "<name>", "args": {...} }` and nothing else. The registry
 * validates every call (known tool, required args, primitive types, no
 * unknown props) so a hallucinated arg can never reach the runtime.
 */

export interface ToolCallRequest {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface CirceTool {
  /** Unique machine name the model addresses, e.g. "memory_recall". */
  name: string;
  /** One or two sentences telling the model when to use this tool. */
  description: string;
  /** JSON Schema object for the args (subset: type, properties, required). */
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/** Live snapshots the built-in tools are bound to. */
export interface ToolContext {
  context: () => string;
  mana: () => Promise<string>;
  recall: (query: string, limit: number) => unknown;
  /** Graph-assisted recall: keyword hits plus facts linked by shared tags. */
  recallGraph: (query: string, limit: number) => unknown;
  /** Tags that most often co-occur with the given tag. */
  related: (tag: string, limit: number) => unknown;
  remember: (text: string, tags: string[]) => unknown;
  /** Optional goal tracker interface for inspecting or advancing multi-turn plans. */
  goals?: {
    status: () => unknown;
    advance: (reason?: string) => unknown;
  };
  /** Optional viewer registry interface for inspecting chatter profiles, notes, and affinity. */
  viewers?: {
    profile: (user: string) => unknown;
    note: (user: string, note: string) => unknown;
    affinity: (user: string, delta: number, reason?: string) => unknown;
  };
}

/**
 * The default Circe tool belt: read the stream scene, feel the mana, and
 * reach into episodic memory. All read-mostly so the model cannot break the
 * stream, with one write tool (memory_remember) that stays inside the store.
 */
export function builtinTools(ctx: ToolContext): CirceTool[] {
  const tools: CirceTool[] = [
    {
      name: "context",
      description: "Read the latest stream scene: recent chat lines and game state.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: () => ({ context: ctx.context() }),
    },
    {
      name: "mana",
      description: "Read the cyber-sorcery meter: memory pool, CPU load, mana reserves.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: async () => ({ mana: await ctx.mana() }),
    },
    {
      name: "memory_recall",
      description:
        "Recall episodic memory facts matching a query (keywords or tags). Set graph:true " +
        "to also include facts connected through co-occurring tags.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to match against facts" },
          limit: { type: "integer", minimum: 1, maximum: 20 },
          graph: { type: "boolean", description: "Include tag-graph-related facts" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      run: ({ query, limit, graph }) =>
        graph === true
          ? { facts: ctx.recallGraph(String(query), Number(limit ?? 5)) }
          : { facts: ctx.recall(String(query), Number(limit ?? 5)) },
    },
    {
      name: "memory_related",
      description: "List tags that most often co-occur with the given tag.",
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string", description: "The tag to explore" },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["tag"],
        additionalProperties: false,
      },
      run: ({ tag, limit }) => ({ related: ctx.related(String(tag), Number(limit ?? 10)) }),
    },
    {
      name: "memory_remember",
      description: "Store a new episodic memory fact, optionally tagged.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The fact to keep" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["text"],
        additionalProperties: false,
      },
      run: ({ text, tags }) => ({
        fact: ctx.remember(
          String(text),
          Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [],
        ),
      }),
    },
  ];

  if (ctx.goals) {
    tools.push(
      {
        name: "goal_status",
        description:
          "Inspect Circe's active stream goal, multi-turn plan, and current sub-step focus.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        run: () => ({ goal: ctx.goals!.status() }),
      },
      {
        name: "goal_advance",
        description:
          "Advance to the next sub-step in the active goal's multi-turn plan once the current sub-step has been accomplished.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Brief reason why the current sub-step is finished",
            },
          },
          additionalProperties: false,
        },
        run: (args) => ({
          result: ctx.goals!.advance(typeof args.reason === "string" ? args.reason : undefined),
        }),
      },
    );
  }

  if (ctx.viewers) {
    tools.push(
      {
        name: "viewer_profile",
        description:
          "Check the relationship tier, affinity score, message count, and notes for a specific chatter.",
        parameters: {
          type: "object",
          properties: {
            user: { type: "string", description: "Chatter username" },
          },
          required: ["user"],
          additionalProperties: false,
        },
        run: (args) => ({ profile: ctx.viewers!.profile(String(args.user)) }),
      },
      {
        name: "viewer_note",
        description:
          "Save a memorable observation, preference, or fact about a specific chatter to their profile.",
        parameters: {
          type: "object",
          properties: {
            user: { type: "string", description: "Chatter username" },
            note: {
              type: "string",
              description: "Fact or observation to remember about this chatter",
            },
          },
          required: ["user", "note"],
          additionalProperties: false,
        },
        run: (args) => ({
          result: ctx.viewers!.note(String(args.user), String(args.note)),
        }),
      },
      {
        name: "viewer_affinity",
        description:
          "Adjust Circe's affinity score toward a chatter (positive for warmth/loyalty, negative for heckling/rudeness).",
        parameters: {
          type: "object",
          properties: {
            user: { type: "string", description: "Chatter username" },
            delta: {
              type: "integer",
              minimum: -50,
              maximum: 50,
              description: "Amount to increase or decrease affinity by",
            },
            reason: { type: "string", description: "Why affinity was adjusted" },
          },
          required: ["user", "delta"],
          additionalProperties: false,
        },
        run: (args) => ({
          result: ctx.viewers!.affinity(
            String(args.user),
            Number(args.delta),
            typeof args.reason === "string" ? args.reason : undefined,
          ),
        }),
      },
    );
  }

  return tools;
}

export class ToolRegistry {
  private readonly tools = new Map<string, CirceTool>();

  constructor(tools: CirceTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: CirceTool): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  list(): CirceTool[] {
    return [...this.tools.values()];
  }

  /**
   * Render the tool belt as a prompt block: name, description, and the JSON
   * Schema of each tool's args.
   */
  describe(): string {
    const lines: string[] = ["[TOOLS]"];
    for (const tool of this.tools.values()) {
      lines.push(
        `- ${tool.name}: ${tool.description} args: ${JSON.stringify(tool.parameters)}`,
      );
    }
    lines.push(
      'To use a tool, output exactly one JSON object and nothing else: {"tool": "<name>", "args": {...}}.',
    );
    return lines.join("\n");
  }

  /**
   * Run a tool call after strict validation. Returns an outcome rather than
   * throwing so the brain loop can feed failures back to the model.
   */
  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `unknown tool: ${name}` };
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { ok: false, error: `invalid args for ${name}: args must be an object` };
    }
    const invalid = this.validateArgs(tool, args);
    if (invalid) return { ok: false, error: `invalid args for ${name}: ${invalid}` };
    try {
      const result = await tool.run(args);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private validateArgs(tool: CirceTool, args: Record<string, unknown>): string | null {
    const schema = tool.parameters as {
      properties?: Record<string, Record<string, unknown>>;
      required?: unknown;
      additionalProperties?: unknown;
    };
    const props = schema.properties ?? {};

    for (const key of Object.keys(args)) {
      if (schema.additionalProperties === false && !(key in props)) {
        return `unknown argument "${key}"`;
      }
    }
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === "string" && args[key] === undefined) return `missing "${key}"`;
    }
    for (const [key, spec] of Object.entries(props)) {
      const value = args[key];
      if (value === undefined) continue;
      const type = spec.type;
      if (type === "string" && typeof value !== "string") return `"${key}" must be a string`;
      if ((type === "number" || type === "integer") && !Number.isFinite(value)) {
        return `"${key}" must be a ${type}`;
      }
      if (type === "integer" && !Number.isInteger(value)) return `"${key}" must be an integer`;
      if (type === "boolean" && typeof value !== "boolean") return `"${key}" must be a boolean`;
      if (type === "array" && !Array.isArray(value)) return `"${key}" must be an array`;
      if (type === "integer" && typeof spec.minimum === "number" && (value as number) < spec.minimum) {
        return `"${key}" must be >= ${spec.minimum}`;
      }
      if (type === "integer" && typeof spec.maximum === "number" && (value as number) > spec.maximum) {
        return `"${key}" must be <= ${spec.maximum}`;
      }
    }
    return null;
  }
}

/**
 * Parse a model reply as a tool call. Tolerates markdown fences and stray
 * prose by scanning every balanced JSON object in the text and returning the
 * first one that matches the envelope shape `{ tool: string, args: object }`.
 * Returns null when the reply is a normal (non-tool) answer.
 */
export function parseToolCall(text: string): ToolCallRequest | null {
  const unfenced = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // Walk the text one char at a time; whenever an opening brace is found,
  // extract the balanced object and test it against the envelope shape.
  for (let start = unfenced.indexOf("{"); start !== -1; start = unfenced.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < unfenced.length; i++) {
      const char = unfenced[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue; // unbalanced; try the next opening brace

    let parsed: unknown;
    try {
      parsed = JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.tool === "string" &&
      candidate.args !== null &&
      typeof candidate.args === "object" &&
      !Array.isArray(candidate.args)
    ) {
      return { tool: candidate.tool, args: candidate.args as Record<string, unknown> };
    }
  }
  return null;
}
