import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { CirceEvent, EventBus } from "./bus.js";
import type { ManaPool } from "./manametry.js";
import type { EpisodicMemory } from "./memory.js";
import type { VisionSampler } from "./vision.js";
import type { GoalTracker } from "./goals.js";
import type { ViewerRegistry, ViewerTier } from "./viewers.js";
import type { VoiceChatStatus } from "./voicechat.js";
import { dashboardHtml } from "./dashboard.js";
import { classifyMarker } from "./expression.js";

export interface ChatMessage {
  user: string;
  message: string;
  ts: number;
}

export interface GameState {
  ts: number;
  [key: string]: unknown;
}

export interface StreamContext {
  chat: ChatMessage[];
  game: GameState | null;
  updatedAt: number;
}

export interface StreamFeedOptions {
  port?: number;
  host?: string;
  maxChat?: number;
  maxBodyBytes?: number;
  /** Cyber-sorcery meter: enables POST /metrics and GET /mana. */
  mana?: ManaPool;
  /** Episodic memory: enables GET /memory and POST /remember. */
  memory?: EpisodicMemory;
  /** Vision sampler: enables GET /vision (latest stream frame). */
  vision?: VisionSampler;
  /** Goal tracker: enables GET /goals (active/pending/completed). */
  goals?: GoalTracker;
  /** Viewer registry: enables GET /viewers and POST /viewers/:user. */
  viewers?: ViewerRegistry;
  /** Reply pipeline: enables POST /reply (parses, speaks, animates). */
  onReply?: (text: string) => Promise<unknown>;
  /** Brain pipeline: enables POST /ask (think, then speak). */
  onAsk?: (message: string, opts?: AskOptions) => Promise<unknown>;
  /** Session recap: enables POST /recap (distill session into memory). */
  onRecap?: () => Promise<unknown>;
  /** Advance active goal sub-step: enables POST /goals/advance. */
  onGoalAdvance?: (reason?: string) => Promise<unknown> | unknown;
  /** Gamer tandem: enables POST /game/step (one observe → decide → act pass). */
  onGameStep?: () => Promise<unknown> | unknown;
  /** Voice chat mode: enables GET /voicechat (running, queued, speaking). */
  voiceChat?: () => VoiceChatStatus | null;
  /** Two-hander mode: enables POST /duet (Circe + partner persona trade lines). */
  onDuet?: (topic: string, opts: DuetRequestOptions) => Promise<unknown>;
}

export interface DuetRequestOptions {
  /** Partner persona id (defaults to Evil Neuro at the runtime layer). */
  partner?: string;
  /** Total lines traded (runtime clamps to 2..12). */
  turns?: number;
  /** Who opens the bit. */
  opener?: "primary" | "partner";
}

export interface AskOptions {
  /** Force the two-pass draft → critique → final brain pass. */
  reflect?: boolean;
  /** Let the brain use the JSON tool envelope before answering. */
  tools?: boolean;
  /** Stream tokens into TTS so speech starts mid-reply. */
  stream?: boolean;
}
const JSON_HEADERS = { "content-type": "application/json" };

function safeDecode(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/**
 * The stream-context feed. Holds the latest chat messages and gameplay state
 * so Circe can react to the live scene, and exposes them over a
 * zero-dependency HTTP/SSE gateway:
 *
 *   GET  /health   -> { ok: true }
 *   GET  /         -> endpoint index
 *   GET  /context  -> current chat + game snapshot
 *   GET  /mana     -> cyber-sorcery snapshot (cpu/memory/gpu/context)
 *   GET  /params   -> latest VTube Studio model params + face snapshot
 *   GET  /memory   -> recall (?q=&limit=), graph recall (?graph=1), or related tags (?tag=)
 *   GET  /vision   -> latest stream frame (JPEG; ?format=json for metadata)
 *   GET  /goals    -> goal tracker status (active/pending/done)
 *   GET  /events   -> SSE stream (replay with ?since=<seq>, heartbeat)
 *   POST /chat     -> { user, message }
 *   POST /game     -> { state: {...} }
 *   POST /game/step -> one gamer tick (observe → decide → act), when enabled
 *   POST /duet     -> { topic, partner?, turns?, opener? } — two-hander banter
 *   POST /metrics  -> { contextUsed, contextTotal }
 *   POST /reply    -> { text } — run Circe's full reply pipeline
 *   POST /ask      -> { message, reflect?, tools?, stream? } — brain answer through the reply pipeline
 *   POST /remember -> { text, tags? } � store an episodic memory
 *   POST /recap    -> distill the session into episodic memory
 *   POST /cue      -> { marker } — fire an expression cue (e.g. "giggles") on the bus
 */
export class StreamContextFeed {
  port: number;
  readonly host: string;

  private chat: ChatMessage[] = [];
  private game: GameState | null = null;
  private updatedAt = 0;
  private server: Server | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly clients = new Set<ServerResponse>();
  private readonly maxChat: number;
  private readonly maxBodyBytes: number;
  private readonly mana: ManaPool | null;
  private readonly memory: EpisodicMemory | null;
  private readonly vision: VisionSampler | null;
  private readonly goals: GoalTracker | null;
  private readonly viewers: ViewerRegistry | null;
  private readonly onReply: ((text: string) => Promise<unknown>) | null;
  private readonly onAsk: ((message: string, opts?: AskOptions) => Promise<unknown>) | null;
  private readonly onRecap: (() => Promise<unknown>) | null;
  private readonly onGoalAdvance: ((reason?: string) => Promise<unknown> | unknown) | null;
  private readonly onGameStep: (() => Promise<unknown> | unknown) | null;
  private readonly voiceChat: (() => VoiceChatStatus | null) | null;
  private readonly onDuet: ((topic: string, opts: DuetRequestOptions) => Promise<unknown>) | null;
  private params: Record<string, number> = {};
  private face: Record<string, unknown> | null = null;

  constructor(private readonly bus: EventBus, options: StreamFeedOptions = {}) {
    this.port = options.port ?? 8788;
    this.host = options.host ?? "127.0.0.1";
    this.maxChat = options.maxChat ?? 50;
    this.maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
    this.mana = options.mana ?? null;
    this.memory = options.memory ?? null;
    this.vision = options.vision ?? null;
    this.goals = options.goals ?? null;
    this.viewers = options.viewers ?? null;
    this.onReply = options.onReply ?? null;
    this.onAsk = options.onAsk ?? null;
    this.onRecap = options.onRecap ?? null;
    this.onGoalAdvance = options.onGoalAdvance ?? null;
    this.onGameStep = options.onGameStep ?? null;
    this.voiceChat = options.voiceChat ?? null;
    this.onDuet = options.onDuet ?? null;
    this.bus.on((event) => this.broadcast(event));
    this.bus.on((event) => {
      if (event.type === "vtube-param" && typeof event.name === "string") {
        this.params[event.name] = typeof event.value === "number" ? event.value : 0;
      } else if (event.type === "vtube-face") {
        this.face = { ...event, type: undefined, seq: undefined, ts: undefined };
      }
    });
  }

  /** Latest VTube Studio model parameters and webcam face snapshot. */
  liveParams(): { params: Record<string, number>; face: Record<string, unknown> | null } {
    return { params: { ...this.params }, face: this.face };
  }

  pushChat(user: string, message: string): ChatMessage {
    const msg: ChatMessage = { user, message, ts: Date.now() };
    this.chat.push(msg);
    if (this.chat.length > this.maxChat) this.chat.shift();
    this.updatedAt = msg.ts;
    this.bus.emit("chat", { user, message });
    return msg;
  }

  setGame(state: Record<string, unknown>): GameState {
    const game: GameState = { ...state, ts: Date.now() };
    this.game = game;
    this.updatedAt = game.ts;
    this.bus.emit("game", state);
    return game;
  }

  context(): StreamContext {
    return { chat: [...this.chat], game: this.game, updatedAt: this.updatedAt };
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.removeListener("error", reject);
        const address = server.address() as AddressInfo;
        if (address && typeof address === "object") this.port = address.port;
        resolve();
      });
    });
    this.server = server;
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.write(": ping\n\n");
    }, 15000);
    this.heartbeat.unref?.();
  }

  async stop(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/health") {
        this.sendJson(res, 200, { ok: true });
      } else if (method === "GET" && path === "/") {
        const wantsHtml =
          !url.searchParams.has("format") &&
          (req.headers.accept ?? "").includes("text/html");
      if (wantsHtml) {
        this.sendHtml(res, dashboardHtml());
      } else {
        this.sendJson(res, 200, {
          ok: true,
          endpoints: [
            "GET /health",
            "GET /context",
          "GET /mana",
          "GET /params",
          "GET /memory",
            "GET /vision",
            "GET /goals",
            "GET /viewers",
            "GET /viewers/:user",
            "GET /events",
            "POST /chat",
            "POST /game",
            "POST /game/step",
            "POST /metrics",
            "POST /reply",
            "POST /ask",
            "GET /voicechat",
            "POST /duet",
            "POST /remember",
            "POST /recap",
            "POST /goals/advance",
            "POST /viewers/:user",
          ],
        });
      }
    } else if (method === "GET" && path === "/context") {
      this.sendJson(res, 200, this.context());
    } else if (method === "GET" && path === "/mana") {
      if (this.mana) {
        this.sendJson(res, 200, await this.mana.snapshot());
      } else {
        this.sendJson(res, 404, { ok: false, error: "mana pool disabled" });
      }
    } else if (method === "GET" && path === "/params") {
      this.sendJson(res, 200, this.liveParams());
    } else if (method === "GET" && path === "/memory") {
      if (!this.memory) {
        this.sendJson(res, 404, { ok: false, error: "memory disabled" });
        return;
      }
      const query = url.searchParams.get("q") ?? "";
      const tag = url.searchParams.get("tag") ?? "";
      const limitParam = Number(url.searchParams.get("limit") ?? 10);
      const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(50, limitParam)) : 10;
      if (tag) {
        this.sendJson(res, 200, { ok: true, tag, related: this.memory.relatedTags(tag, limit) });
      } else if (url.searchParams.get("graph") === "1") {
        this.sendJson(res, 200, { ok: true, results: this.memory.graphRecall(query, limit) });
      } else {
        this.sendJson(res, 200, {
          ok: true,
          facts: query ? this.memory.recall(query, limit) : this.memory.all().slice(-limit).reverse(),
        });
      }
    } else if (method === "GET" && path === "/vision") {
      const frame = this.vision?.latest();
      if (!frame?.ok) {
        this.sendJson(res, 404, { ok: false, error: "no vision frame" });
        return;
      }
      if (url.searchParams.get("format") === "json") {
        this.sendJson(res, 200, { ok: true, ts: frame.ts, file: frame.file });
        return;
      }
      try {
        const bytes = readFileSync(frame.file);
        res.writeHead(200, {
          "content-type": "image/jpeg",
          "content-length": bytes.length,
          "cache-control": "no-store",
        });
        res.end(bytes);
      } catch {
        this.sendJson(res, 404, { ok: false, error: "frame file missing" });
      }
    } else if (method === "GET" && path === "/goals") {
      if (!this.goals) {
        this.sendJson(res, 404, { ok: false, error: "goals disabled" });
        return;
      }
      const status = this.goals.status();
      this.sendJson(res, 200, {
        ok: true,
        active: status.active,
        pending: status.pending.map((goal) => ({ id: goal.id, description: goal.description })),
        done: status.done,
      });
    } else if (method === "GET" && (path === "/viewers" || path.startsWith("/viewers/"))) {
      if (!this.viewers) {
        this.sendJson(res, 404, { ok: false, error: "viewers disabled" });
        return;
      }
      if (path === "/viewers") {
        const tierParam = url.searchParams.get("tier");
        const sortParam = url.searchParams.get("sort");
        const limitParam = url.searchParams.get("limit");
        const tier =
          tierParam === "newcomer" ||
          tierParam === "regular" ||
          tierParam === "vip" ||
          tierParam === "heckler"
            ? (tierParam as ViewerTier)
            : undefined;
        const sort =
          sortParam === "messages" || sortParam === "affinity" || sortParam === "lastSeen"
            ? sortParam
            : undefined;
        const limit = limitParam ? parseInt(limitParam, 10) : undefined;
        const viewers = this.viewers.all({
          tier,
          sort,
          limit: Number.isFinite(limit) ? limit : undefined,
        });
        this.sendJson(res, 200, { ok: true, viewers });
        return;
      }
      const user = safeDecode(path.slice("/viewers/".length)).trim();
      if (!user) {
        this.sendJson(res, 400, { ok: false, error: "user required" });
        return;
      }
      const viewer = this.viewers.get(user);
      if (!viewer) {
        this.sendJson(res, 404, { ok: false, error: "viewer not found" });
        return;
      }
      this.sendJson(res, 200, { ok: true, viewer });
    } else if (method === "GET" && path === "/events") {
      this.handleEvents(req, res);
    } else if (method === "GET" && path === "/voicechat") {
      const status = this.voiceChat?.();
      if (!status) {
        this.sendJson(res, 404, { ok: false, error: "voice chat disabled" });
      } else {
        this.sendJson(res, 200, { ok: true, ...status });
      }
    } else if (
      method === "POST" &&
      (path === "/chat" ||
        path === "/cue" ||
        path === "/game" ||
        path === "/metrics" ||
        path === "/reply" ||
        path === "/ask" ||
        path === "/remember" ||
        path === "/recap" ||
        path === "/goals/advance" ||
        path === "/game/step" ||
        path === "/duet" ||
        path.startsWith("/viewers/"))
    ) {
      await this.handlePost(req, res, path);
    } else {
      this.sendJson(res, 404, { ok: false, error: "not found" });
    }
  } catch (err) {
    if (!res.headersSent) {
      this.sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
  }
}

  private async handlePost(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    let body: string;
    try {
      body = await this.readBody(req);
    } catch (err) {
      this.sendJson(res, 413, { ok: false, error: (err as Error).message });
      return;
    }

    let data: Record<string, unknown> = {};
    if (body.trim()) {
      try {
        data = JSON.parse(body) as Record<string, unknown>;
      } catch {
        this.sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
    }

    if (path === "/chat") {
      const user = typeof data.user === "string" ? data.user : "anon";
      const message = typeof data.message === "string" ? data.message.trim() : "";
      if (!message) {
        this.sendJson(res, 400, { ok: false, error: "message required" });
        return;
      }
      this.sendJson(res, 200, { ok: true, message: this.pushChat(user, message) });
      return;
    }

    if (path === "/cue") {
      const raw = typeof data.marker === "string" ? data.marker.replace(/\*/g, "").trim() : "";
      if (!raw || raw.length > 80) {
        this.sendJson(res, 400, { ok: false, error: "marker required (1-80 chars)" });
        return;
      }
      const cue = classifyMarker(raw);
      this.bus.emit("expression", { ...cue, source: "remote" });
      this.sendJson(res, 200, { ok: true, cue });
      return;
    }

    if (path === "/metrics") {
      if (!this.mana) {
        this.sendJson(res, 404, { ok: false, error: "mana pool disabled" });
        return;
      }
      const contextUsed = typeof data.contextUsed === "number" ? data.contextUsed : NaN;
      const contextTotal = typeof data.contextTotal === "number" ? data.contextTotal : NaN;
      if (!Number.isFinite(contextUsed) || !Number.isFinite(contextTotal)) {
        this.sendJson(res, 400, { ok: false, error: "contextUsed and contextTotal required" });
        return;
      }
      this.mana.setContext(contextUsed, contextTotal);
      this.bus.emit("metrics", { contextUsed, contextTotal });
      this.sendJson(res, 200, { ok: true, contextUsed, contextTotal });
      return;
    }

    if (path === "/reply") {
      if (!this.onReply) {
        this.sendJson(res, 404, { ok: false, error: "reply pipeline disabled" });
        return;
      }
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (!text) {
        this.sendJson(res, 400, { ok: false, error: "text required" });
        return;
      }
      try {
        const reply = await this.onReply(text);
        this.sendJson(res, 200, { ok: true, reply });
      } catch (err) {
        this.sendJson(res, 500, { ok: false, error: (err as Error).message });
      }
      return;
    }

    if (path === "/ask") {
      if (!this.onAsk) {
        this.sendJson(res, 404, { ok: false, error: "brain disabled" });
        return;
      }
      const message = typeof data.message === "string" ? data.message.trim() : "";
      if (!message) {
        this.sendJson(res, 400, { ok: false, error: "message required" });
        return;
      }
      try {
        const answer = await this.onAsk(message, {
          reflect: data.reflect === true,
          tools: data.tools === true,
          stream: data.stream === true,
        });
        this.sendJson(res, 200, { ok: true, ...(answer as object) });
      } catch (err) {
        this.sendJson(res, 500, { ok: false, error: (err as Error).message });
      }
      return;
    }

    if (path === "/duet") {
      if (!this.onDuet) {
        this.sendJson(res, 404, { ok: false, error: "brain disabled" });
        return;
      }
      const topic = typeof data.topic === "string" ? data.topic.trim() : "";
      if (!topic) {
        this.sendJson(res, 400, { ok: false, error: "topic required" });
        return;
      }
      const turnsRaw = Number(data.turns);
      const options: DuetRequestOptions = {
        ...(typeof data.partner === "string" && data.partner.trim()
          ? { partner: data.partner.trim() }
          : {}),
        ...(Number.isFinite(turnsRaw) ? { turns: Math.max(2, Math.min(12, Math.round(turnsRaw))) } : {}),
        ...(data.opener === "partner" || data.opener === "primary" ? { opener: data.opener } : {}),
      };
      try {
        const result = await this.onDuet(topic, options);
        this.sendJson(res, 200, { ok: true, result });
      } catch (err) {
        this.sendJson(res, 500, { ok: false, error: (err as Error).message });
      }
      return;
    }

    if (path === "/recap") {
      if (!this.onRecap) {
        this.sendJson(res, 404, { ok: false, error: "recap disabled" });
        return;
      }
      try {
        const recap = await this.onRecap();
        this.sendJson(res, 200, { ok: true, recap });
      } catch (err) {
        this.sendJson(res, 500, { ok: false, error: (err as Error).message });
      }
      return;
    }

    if (path === "/game/step") {
      if (!this.onGameStep) {
        this.sendJson(res, 404, { ok: false, error: "gamer disabled" });
        return;
      }
      try {
        const action = await this.onGameStep();
        this.sendJson(res, 200, { ok: true, action });
      } catch (err) {
        this.sendJson(res, 500, { ok: false, error: (err as Error).message });
      }
      return;
    }

    if (path === "/goals/advance") {
      if (!this.goals) {
        this.sendJson(res, 404, { ok: false, error: "goals disabled" });
        return;
      }
      const reason = typeof data.reason === "string" ? data.reason.trim() : undefined;
      try {
        const result = this.onGoalAdvance
          ? await this.onGoalAdvance(reason)
          : this.goals.advanceStep(reason);
        this.sendJson(res, 200, { ok: true, result, active: this.goals.status().active });
      } catch (err) {
        this.sendJson(res, 500, { ok: false, error: (err as Error).message });
      }
      return;
    }

    if (path.startsWith("/viewers/")) {
      if (!this.viewers) {
        this.sendJson(res, 404, { ok: false, error: "viewers disabled" });
        return;
      }
      const user = safeDecode(path.slice("/viewers/".length)).trim();
      if (!user) {
        this.sendJson(res, 400, { ok: false, error: "user required" });
        return;
      }
      let profile = this.viewers.getOrCreate(user);
      if (typeof data.delta === "number" && Number.isFinite(data.delta)) {
        profile = this.viewers.adjustAffinity(
          user,
          data.delta,
          typeof data.reason === "string" ? data.reason : undefined,
        );
      }
      if (
        typeof data.tier === "string" &&
        (data.tier === "newcomer" ||
          data.tier === "regular" ||
          data.tier === "vip" ||
          data.tier === "heckler")
      ) {
        profile = this.viewers.setTier(user, data.tier as ViewerTier);
      }
      if (typeof data.note === "string" && data.note.trim()) {
        profile = this.viewers.addNote(user, data.note.trim());
      }
      if (typeof data.personaId === "string") {
        profile = this.viewers.setPersona(user, data.personaId.trim() || undefined);
      }
      this.bus.emit("viewer-update", { user: profile.user, profile });
      this.sendJson(res, 200, { ok: true, viewer: profile });
      return;
    }

    if (path === "/remember") {
      if (!this.memory) {
        this.sendJson(res, 404, { ok: false, error: "memory disabled" });
        return;
      }
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (!text) {
        this.sendJson(res, 400, { ok: false, error: "text required" });
        return;
      }
      const tags = Array.isArray(data.tags)
        ? data.tags.filter((tag): tag is string => typeof tag === "string")
        : [];
      try {
        const fact = this.memory.remember(text, tags);
        this.bus.emit("memory", { id: fact.id, text: fact.text, tags: fact.tags });
        this.sendJson(res, 200, { ok: true, fact });
      } catch (err) {
        this.sendJson(res, 400, { ok: false, error: (err as Error).message });
      }
      return;
    }

    const state =
      data.state && typeof data.state === "object"
        ? (data.state as Record<string, unknown>)
        : {};
    this.sendJson(res, 200, { ok: true, game: this.setGame(state) });
  }

  private handleEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 1000\n\n");

    const url = new URL(req.url ?? "/", "http://localhost");
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    for (const event of this.bus.since(since)) this.writeEvent(res, event);

    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  private writeEvent(res: ServerResponse, event: CirceEvent): void {
    if (res.writableEnded || res.destroyed) {
      this.clients.delete(res);
      return;
    }
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      this.clients.delete(res);
    }
  }

  private broadcast(event: CirceEvent): void {
    for (const client of this.clients) this.writeEvent(client, event);
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      req.on("data", (chunk: Buffer) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          tooLarge = true;
          reject(new Error("body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", (err) => reject(err));
    });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { ...JSON_HEADERS, "content-length": Buffer.byteLength(json) });
    res.end(json);
  }

  private sendHtml(res: ServerResponse, html: string): void {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
    });
    res.end(html);
  }
}


