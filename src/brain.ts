import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseToolCall, ToolCallRequest, ToolOutcome, ToolRegistry } from "./tools.js";
import { DEFAULT_PERSONA } from "./persona.js";
import type { Persona } from "./persona.js";
import type { LlmImagePart } from "./vision.js";

export type LlmContentPart = { type: "text"; text: string } | LlmImagePart;

export interface BrainOptions {
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1 (Ollama) or http://127.0.0.1:5001/v1 (KoboldCPP). */
  baseUrl: string;
  /** Model name understood by the server, e.g. "llama3.1:8b". */
  model: string;
  /** Bearer token for gateways that require one. */
  apiKey?: string;
  /** Persona system prompt; defaults to SYSTEM_PROMPT.md, then CIRCE.md. */
  systemPrompt?: string;
  /**
   * Persona override: swaps the identity and reasoning flavor for this brain
   * without touching the base options (e.g. Evil Neuro running her own prompt).
   */
  persona?: Persona;
  temperature?: number;
  maxTokens?: number;
  /** Rolling conversation turns kept between calls (default 24). */
  maxHistory?: number;
  timeoutMs?: number;
  /** JSONL file that persists conversation turns across restarts. */
  historyFile?: string;
  /**
   * Two-pass reflection: draft the reply, then have the model critique and
   * rewrite it before speaking. Roughly doubles latency per turn but raises
   * banter quality; opt-in per session (or per call via `reply()` options).
   */
  reflect?: boolean;
  /** Custom critic system prompt for the reflection pass. */
  reflectPrompt?: string;
  /** Observability hook: fires with the draft and the final reply. */
  onReflect?: (info: ReflectInfo) => void;
  /**
   * Multimodal hook: return the latest stream frame as an image part, and
   * every user turn becomes multimodal (requires a vision-capable model).
   */
  getFrame?: () => LlmContentPart | null;
  /** Test hook: inject a fetch implementation. */
  fetchImpl?: typeof fetch;
}

/** What the reflection pass saw: the draft, the final reply, and any failure. */
export interface ReflectInfo {
  draft: string;
  final: string;
  /** Set when the critique pass failed and the draft was kept as-is. */
  error?: string;
}

export interface ReplyOptions {
  /** Override the session-level reflect setting for this single call. */
  reflect?: boolean;
  /**
   * External critic (writer + critic multi-agent): when set and reflection
   * runs, the critique pass goes to this executor instead of the same brain.
   * Receives the ready critique messages and returns the final reply.
   */
  critic?: (messages: LlmMessage[]) => Promise<string>;
  /** Persona override for this call; falls back to the brain's persona. */
  persona?: Persona;
}

export interface StreamReplyOptions {
  /** Fired per token delta as it arrives from the server. */
  onChunk?: (chunk: string, fullText: string) => void;
  /** Persona override for this call; falls back to the brain's persona. */
  persona?: Persona;
}

export interface AskToolsOptions {
  /** The tool belt the model may reach for. */
  tools: ToolRegistry;
  /** Maximum observe-plan-act rounds before giving up (default 4). */
  maxRounds?: number;
  /** Observability hook: fires for every tool call and its outcome. */
  onTool?: (call: ToolCallRequest, outcome: ToolOutcome) => void;
  /** Persona override for this call; falls back to the brain's persona. */
  persona?: Persona;
}

export interface BrainTurn {
  role: "user" | "assistant";
  content: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | LlmContentPart[];
}

const CRITIC_PROMPT =
  "You are Circe-Core's inner critic. Review the draft reply to the message below and " +
  "rewrite it into the final reply: fix anything awkward for text-to-speech, tighten pacing " +
  "to 1-3 short sentences, keep the *asterisk* action markers, and preserve her voice. " +
  "Output ONLY the final reply text — no quotes, no commentary.";

function loadDefaultPrompt(): string {
  for (const file of ["SYSTEM_PROMPT.md", "CIRCE.md"]) {
    try {
      const text = readFileSync(file, "utf8").trim();
      if (text) return text;
    } catch {
      // try the next candidate
    }
  }
  return DEFAULT_PERSONA.systemPrompt;
}

/**
 * Circe's local brain: an OpenAI-compatible chat-completions client for
 * Ollama, KoboldCPP, LM Studio, or any gateway that speaks the same dialect.
 * Keeps a rolling conversation history so she can hold a thread across turns,
 * and accepts an extra context block (stream scene + cyber-sorcery snapshot)
 * injected fresh into every system prompt.
 */
export class CirceBrain {
  private history: BrainTurn[] = [];
  private readonly fetchImpl: typeof fetch;
  private activePersona?: Persona;

  constructor(private readonly options: BrainOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.activePersona = options.persona;
    if (options.historyFile) this.history = this.loadHistory(options.historyFile);
  }

  reset(): void {
    this.history = [];
    if (this.options.historyFile) {
      try {
        writeFileSync(this.options.historyFile, "");
      } catch {
        // memory is cleared regardless; persistence stays best-effort
      }
    }
  }

  /** The persona currently driving this brain, if one is set. */
  persona(): Persona | undefined {
    return this.activePersona;
  }

  /** Swap the persona mid-flight (e.g. Circe → Evil Neuro). */
  setPersona(persona: Persona): void {
    this.activePersona = persona;
  }

  /** Effective system prompt: persona first, then explicit option, then default. */
  private systemPrompt(persona?: Persona): string {
    const source = persona ?? this.activePersona ?? this.options;
    const prompt = source.systemPrompt;
    return (prompt ?? DEFAULT_PERSONA.systemPrompt).trim();
  }

  /** Effective LLM config: persona-scoped overrides layered over the base options. */
  private llm(persona?: Persona): BrainOptions {
    const personaLlm = persona?.llm ?? this.activePersona?.llm;
    if (!personaLlm) return this.options;
    return { ...this.options, ...personaLlm };
  }

  /** Current rolling history, oldest first. */
  turns(): BrainTurn[] {
    return [...this.history];
  }

  async reply(
    userMessage: string,
    extraContext = "",
    opts: ReplyOptions = {},
  ): Promise<string> {
    const reflect = opts.reflect ?? this.options.reflect ?? false;
    const system = this.systemPrompt(opts.persona);
    const context = extraContext.trim();
    const messages = this.draftMessages(system, context, userMessage);

    if (!reflect) {
      const answer = await this.complete(messages, opts.persona);
      this.recordTurn({ role: "user", content: userMessage }, { role: "assistant", content: answer });
      return answer;
    }

    const draft = await this.complete(messages, opts.persona);
    let final: string;
    let error: string | undefined;
    try {
      final = await (opts.critic ?? ((m) => this.complete(m)))([
        {
          role: "system",
          content: [system, context, this.options.reflectPrompt ?? CRITIC_PROMPT]
            .filter(Boolean)
            .join("\n\n"),
        },
        {
          role: "user",
          content:
            `Message to reply to:\n"""\n${userMessage}\n"""\n\n` +
            `Your draft:\n"""\n${draft}\n"""`,
        },
      ]);
    } catch (err) {
      // The show must go on: keep the draft rather than drop the reply.
      final = draft;
      error = err instanceof Error ? err.message : String(err);
    }
    this.options.onReflect?.({ draft, final, ...(error ? { error } : {}) });
    this.recordTurn({ role: "user", content: userMessage }, { role: "assistant", content: final });
    return final;
  }

  /**
   * Observe-plan-act loop: the model may call tools (strict JSON envelope)
   * to gather context, mana, or memories before delivering its spoken reply.
   * Tool results (or errors) are fed back as user turns until the model
   * answers plainly; only the final answer enters the conversation history.
   */
  async askWithTools(
    userMessage: string,
    extraContext = "",
    opts: AskToolsOptions,
  ): Promise<string> {
    const system = this.systemPrompt(opts.persona);
    const context = [extraContext.trim(), opts.tools.describe()].filter(Boolean).join("\n\n");
    const messages = this.draftMessages(system, context, userMessage);
    const maxRounds = opts.maxRounds ?? 4;

    for (let round = 0; round < maxRounds; round++) {
      const text = await this.complete(messages, opts.persona);
      const call = parseToolCall(text);
      if (!call) {
        this.recordTurn({ role: "user", content: userMessage }, { role: "assistant", content: text });
        return text;
      }
      const outcome = await opts.tools.call(call.tool, call.args);
      opts.onTool?.(call, outcome);
      messages.push(
        { role: "assistant", content: text },
        {
          role: "user",
          content: outcome.ok
            ? `TOOL RESULT (${call.tool}): ${JSON.stringify(outcome.result)}`
            : `TOOL ERROR (${call.tool}): ${outcome.error ?? "unknown"}`,
        },
      );
    }
    throw new Error(`brain tool loop exceeded ${maxRounds} rounds`);
  }

  /**
   * Streaming reply: same contract as `reply()`, but the model's tokens are
   * delivered to `onChunk` as they arrive (SSE over `stream: true`) so TTS
   * can start speaking before the full reply exists. The complete answer is
   * still recorded into conversation history once the stream finishes.
   */
  async streamReply(
    userMessage: string,
    extraContext = "",
    opts: StreamReplyOptions = {},
  ): Promise<string> {
    const system = this.systemPrompt(opts.persona);
    const context = extraContext.trim();
    const messages = this.draftMessages(system, context, userMessage);
    const answer = await this.streamComplete(messages, (delta, full) => opts.onChunk?.(delta, full), opts.persona);
    this.recordTurn({ role: "user", content: userMessage }, { role: "assistant", content: answer });
    return answer;
  }

  /** Build the standard message stack (system + context, history, user turn). */
  private draftMessages(system: string, context: string, userMessage: string): LlmMessage[] {
    const messages: LlmMessage[] = [
      { role: "system", content: context ? `${system}\n\n${context}` : system },
    ];
    const maxHistory = this.options.maxHistory ?? 24;
    for (const turn of this.history.slice(-maxHistory)) messages.push(turn);
    messages.push({ role: "user", content: this.userContent(userMessage) });
    return messages;
  }

  /** The incoming user turn: plain text, or text + stream frame when set. */
  private userContent(text: string): string | LlmContentPart[] {
    const frame = this.options.getFrame?.();
    if (!frame) return text;
    return [{ type: "text", text }, frame];
  }

  /**
   * One raw completion against this brain's endpoint, without touching the
   * conversation history. This is the agent-to-agent seam: another brain
   * (e.g. a critic agent) can execute messages through it.
   */
  async execute(messages: LlmMessage[]): Promise<string> {
    return this.complete(messages);
  }

  /** One raw chat-completions call: returns the trimmed assistant text. */
  private async complete(messages: LlmMessage[], persona?: Persona): Promise<string> {
    const llm = this.llm(persona);
    const url = `${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);
    timer.unref?.();

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: llm.model,
          messages,
          temperature: this.options.temperature ?? 0.8,
          max_tokens: this.options.maxTokens ?? 256,
          stream: false,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`brain HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("brain returned an empty reply");
    return content;
  }

  /**
   * One streaming chat-completions call: reads the SSE body, feeds every
   * token delta to `onDelta`, and resolves with the full trimmed answer.
   * The timeout covers the entire stream, not just the response headers.
   */
  private async streamComplete(
    messages: LlmMessage[],
    onDelta: (delta: string, fullText: string) => void,
    persona?: Persona,
  ): Promise<string> {
    const llm = this.llm(persona);
    const url = `${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);
    timer.unref?.();

    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: llm.model,
          messages,
          temperature: this.options.temperature ?? 0.8,
          max_tokens: this.options.maxTokens ?? 256,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`brain HTTP ${res.status}`);
      if (!res.body) throw new Error("brain stream returned no body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let carry = "";
      let full = "";
      const handleLine = (raw: string): void => {
        const line = raw.trim();
        if (!line.startsWith("data:")) return;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        let parsed: { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
        try {
          parsed = JSON.parse(payload) as typeof parsed;
        } catch {
          return; // ignore malformed keep-alive or partial lines
        }
        if (parsed.error?.message) throw new Error(`brain stream error: ${parsed.error.message}`);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          full += delta;
          onDelta(delta, full);
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        carry += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = carry.indexOf("\n")) !== -1) {
          const line = carry.slice(0, idx);
          carry = carry.slice(idx + 1);
          handleLine(line);
        }
      }
      carry += decoder.decode();
      if (carry.trim()) handleLine(carry);

      const answer = full.trim();
      if (!answer) throw new Error("brain returned an empty reply");
      return answer;
    } finally {
      clearTimeout(timer);
    }
  }

  private recordTurn(userTurn: BrainTurn, assistantTurn: BrainTurn): void {
    this.history.push(userTurn, assistantTurn);
    this.persistTurn(userTurn);
    this.persistTurn(assistantTurn);
  }

  private loadHistory(file: string): BrainTurn[] {
    try {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      const turns: BrainTurn[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { role?: unknown; content?: unknown };
          if (
            (parsed.role === "user" || parsed.role === "assistant") &&
            typeof parsed.content === "string"
          ) {
            turns.push({ role: parsed.role, content: parsed.content });
          }
        } catch {
          // skip corrupt lines rather than losing the whole history
        }
      }
      return turns.slice(-200);
    } catch {
      return [];
    }
  }

  private persistTurn(turn: BrainTurn): void {
    const file = this.options.historyFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(turn) + "\n");
    } catch {
      // persistence is best-effort; never break the conversation over it
    }
  }
}
