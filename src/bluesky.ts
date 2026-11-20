import type { EventBus } from "./bus.js";

export interface BlueskyOptions {
  /**
   * Streamer handles Circe listens for (without "@"). Posts that reply to
   * these accounts — or mention them — become chat lines.
   */
  handles: string[];
  /**
   * Jetstream firehose endpoint (defaults to the public US-East instance,
   * filtered to `app.bsky.feed.post`).
   */
  endpoint?: string;
  /** Identity resolution endpoint (handle → DID). */
  resolveUrl?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Skip posts authored by the configured handles themselves (default true). */
  skipSelf?: boolean;
  /** Test hook: supply your own socket factory (defaults to the global WebSocket). */
  wsFactory?: (url: string) => BlueskySocket;
  /** Test hook: inject a fetch implementation for handle resolution. */
  fetchImpl?: typeof fetch;
}

export interface BlueskySocket {
  addEventListener(type: string, handler: (event: unknown) => void): void;
  close(): void;
}

export interface BlueskyMessage {
  user: string;
  message: string;
  uri: string;
  ts: number;
}

const DEFAULT_ENDPOINT =
  "wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post";
const DEFAULT_RESOLVE = "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle";

function defaultWs(url: string): BlueskySocket {
  if (typeof WebSocket === "undefined") {
    throw new Error("global WebSocket unavailable — Node 22.4+ required for the Bluesky adapter");
  }
  return new WebSocket(url) as unknown as BlueskySocket;
}

interface JetstreamCommit {
  did: string;
  kind: string;
  time_us?: number;
  commit?: {
    operation?: string;
    collection?: string;
    rkey?: string;
    record?: {
      text?: string;
      reply?: { parent?: { uri?: string }; root?: { uri?: string } };
      facets?: { features?: { $type?: string; did?: string }[] }[];
    };
  };
  identity?: { handle?: string };
}

/** Extract a readable message from one Jetstream commit, if it is a post. */
export function parseJetstream(data: string): JetstreamCommit | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const event = parsed as JetstreamCommit;
  if (event.kind !== "commit") return null;
  if (event.commit?.operation !== "create") return null;
  if (event.commit?.collection !== "app.bsky.feed.post") return null;
  return event;
}

/**
 * Whether the post touches one of the watched accounts: a reply whose parent
 * belongs to a watched DID, a facet mention of one, or a raw `@handle` in
 * the text (fallback when the DID could not be resolved).
 */
export function postMatches(
  event: JetstreamCommit,
  dids: Set<string>,
  handles: Set<string>,
): boolean {
  const record = event.commit?.record;
  if (!record) return false;
  const parent = record.reply?.parent?.uri ?? "";
  for (const did of dids) {
    if (parent.startsWith(`at://${did}/`)) return true;
  }
  for (const facet of record.facets ?? []) {
    for (const feature of facet.features ?? []) {
      if (feature.$type === "app.bsky.richtext.facet#mention" && feature.did && dids.has(feature.did)) {
        return true;
      }
    }
  }
  const text = (record.text ?? "").toLowerCase();
  for (const handle of handles) {
    if (text.includes(`@${handle.toLowerCase()}`)) return true;
  }
  return false;
}

/**
 * Zero-dependency Bluesky social ingest over the public Jetstream firehose.
 * Resolves the streamer handles to DIDs, then listens for posts that reply
 * to or mention them and emits `bluesky-message` bus events (which the
 * runtime folds into the stream-context feed, like Twitch/YouTube chat).
 * Reconnects with backoff.
 */
export class BlueskyChat {
  private ws: BlueskySocket | null = null;
  private closed = false;
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly dids = new Set<string>();
  private readonly handles = new Set<string>();
  private readonly options: Required<
    Pick<BlueskyOptions, "endpoint" | "resolveUrl" | "reconnectBaseMs" | "reconnectMaxMs" | "skipSelf">
  > & { wsFactory: (url: string) => BlueskySocket; fetchImpl: typeof fetch };

  constructor(
    private readonly bus: EventBus,
    options: BlueskyOptions,
  ) {
    for (const handle of options.handles) {
      this.handles.add(handle.trim().toLowerCase().replace(/^@/, ""));
    }
    this.options = {
      endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
      resolveUrl: options.resolveUrl ?? DEFAULT_RESOLVE,
      reconnectBaseMs: options.reconnectBaseMs ?? 1000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      skipSelf: options.skipSelf ?? true,
      wsFactory: options.wsFactory ?? defaultWs,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
    };
  }

  start(): void {
    if (this.closed) {
      this.closed = false;
      this.reconnects = 0;
    }
    if (this.ws || this.reconnectTimer) return;
    void this.begin();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  /** Resolved DIDs for the configured handles (empty until resolution runs). */
  get resolvedDids(): string[] {
    return [...this.dids];
  }

  private async begin(): Promise<void> {
    await this.resolveDids();
    if (this.closed) return;
    let socket: BlueskySocket;
    try {
      socket = this.options.wsFactory(this.options.endpoint);
    } catch (err) {
      this.bus.emit("bluesky-error", { message: (err as Error).message });
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    socket.addEventListener("open", () => {
      this.reconnects = 0;
      this.bus.emit("bluesky-connected", { handles: [...this.handles] });
    });
    socket.addEventListener("message", (event: unknown) => {
      this.onData((event as { data?: unknown }).data);
    });
    socket.addEventListener("close", () => this.onClose());
    socket.addEventListener("error", () => {
      this.bus.emit("bluesky-error", { message: "socket error" });
    });
  }

  private async resolveDids(): Promise<void> {
    for (const handle of this.handles) {
      try {
        const res = await this.options.fetchImpl(`${this.options.resolveUrl}?handle=${handle}`);
        if (!res.ok) continue;
        const data = (await res.json()) as { did?: unknown };
        if (typeof data.did === "string" && data.did) this.dids.add(data.did);
      } catch {
        // resolution is best-effort; text @mention matching still works
      }
    }
    if (this.dids.size === 0) {
      this.bus.emit("bluesky-error", {
        message: "could not resolve any handles; falling back to @mention text matching",
      });
    }
  }

  private onData(data: unknown): void {
    if (typeof data !== "string") return;
    const event = parseJetstream(data);
    if (!event) return;
    const handle = event.identity?.handle ?? "";
    if (!handle) return;
    if (this.options.skipSelf && this.handles.has(handle.toLowerCase())) return;
    if (!postMatches(event, this.dids, this.handles)) return;
    const text = (event.commit?.record?.text ?? "").trim();
    if (!text) return;
    const rkey = event.commit?.rkey ?? "";
    const uri = `at://${event.did}/${event.commit?.collection ?? "app.bsky.feed.post"}/${rkey}`;
    this.bus.emit("bluesky-message", {
      user: handle,
      message: text,
      uri,
      ts: Math.floor((event.time_us ?? Date.now() * 1000) / 1000),
    });
  }

  private onClose(): void {
    this.ws = null;
    if (!this.closed) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(
      this.options.reconnectBaseMs * 2 ** this.reconnects,
      this.options.reconnectMaxMs,
    );
    this.reconnects += 1;
    this.bus.emit("bluesky-error", { message: `reconnecting in ${delay}ms` });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.begin();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
