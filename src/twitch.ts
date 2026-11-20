import type { EventBus } from "./bus.js";

export interface TwitchOptions {
  /** Channels to join, without the leading "#". */
  channels: string[];
  /** IRC nickname; defaults to a random `justinfanNNNNN` (anonymous, read-only). */
  nickname?: string;
  /** OAuth token (without the "oauth:" prefix) for a real account. */
  token?: string;
  host?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Test hook: supply your own socket factory (defaults to the global WebSocket). */
  wsFactory?: (url: string) => TwitchSocket;
}

export interface TwitchSocket {
  addEventListener(type: string, handler: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

export interface TwitchMessage {
  channel: string;
  user: string;
  message: string;
  tags: Record<string, string>;
}

const DEFAULT_HOST = "irc-ws.chat.twitch.tv";

function defaultWs(url: string): TwitchSocket {
  if (typeof WebSocket === "undefined") {
    throw new Error("global WebSocket unavailable — Node 22.4+ required for the Twitch adapter");
  }
  return new WebSocket(url) as unknown as TwitchSocket;
}

/**
 * Parse one Twitch IRC PRIVMSG line (tags + source + channel + message).
 */
export function parsePrivmsg(line: string): TwitchMessage | null {
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const end = rest.indexOf(" ");
    if (end === -1) return null;
    for (const pair of rest.slice(1, end).split(";")) {
      const eq = pair.indexOf("=");
      if (eq > 0) {
        tags[pair.slice(0, eq)] = pair
          .slice(eq + 1)
          .replace(/\\s/g, " ")
          .replace(/\\:/g, ";")
          .replace(/\\\\/g, "\\");
      }
    }
    rest = rest.slice(end + 1);
  }
  const match = rest.match(/^:([^!]+)![^ ]+ PRIVMSG (#[^ ]+) :(.*)$/);
  if (!match) return null;
  return { channel: match[2], user: tags["display-name"] ?? match[1], message: match[3], tags };
}

/**
 * Zero-dependency Twitch chat ingest over IRC-over-WebSocket. Joins the
 * configured channels and emits every chat line as a `twitch-message` bus
 * event (which the runtime folds into the stream-context feed). Anonymous
 * `justinfan` connections work for read-only chat without credentials;
 * pass a `token` for a logged-in connection. Reconnects with backoff.
 */
export class TwitchChat {
  private ws: TwitchSocket | null = null;
  private closed = false;
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: Required<
    Pick<TwitchOptions, "channels" | "host" | "reconnectBaseMs" | "reconnectMaxMs">
  > &
    Pick<TwitchOptions, "nickname" | "token"> & {
      wsFactory: (url: string) => TwitchSocket;
    };

  constructor(
    private readonly bus: EventBus,
    options: TwitchOptions,
  ) {
    this.options = {
      channels: options.channels,
      nickname: options.nickname ?? `justinfan${Math.floor(10000 + Math.random() * 89999)}`,
      token: options.token,
      host: options.host ?? DEFAULT_HOST,
      reconnectBaseMs: options.reconnectBaseMs ?? 1000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      wsFactory: options.wsFactory ?? defaultWs,
    };
  }

  start(): void {
    if (this.closed) {
      this.closed = false;
      this.reconnects = 0;
    }
    if (this.ws || this.reconnectTimer) return;
    this.connect();
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

  private connect(): void {
    let socket: TwitchSocket;
    try {
      socket = this.options.wsFactory(`wss://${this.options.host}:443`);
    } catch (err) {
      this.bus.emit("twitch-error", { message: (err as Error).message });
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    socket.addEventListener("open", () => this.onOpen());
    socket.addEventListener("message", (event: unknown) => {
      this.onData((event as { data?: unknown }).data);
    });
    socket.addEventListener("close", () => this.onClose());
    socket.addEventListener("error", () => {
      this.bus.emit("twitch-error", { message: "socket error" });
    });
  }

  private onOpen(): void {
    const pass = this.options.token ? `oauth:${this.options.token}` : "SCHMOOPIIE";
    const send = (line: string) => this.ws?.send(line);
    send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    send(`PASS ${pass}`);
    send(`NICK ${this.options.nickname}`);
    send(`JOIN ${this.options.channels.map((c) => `#${c.replace(/^#/, "")}`).join(",")}`);
    this.reconnects = 0;
    this.bus.emit("twitch-connected", { channels: [...this.options.channels] });
  }

  private onData(data: unknown): void {
    if (typeof data !== "string") return;
    for (const line of data.split("\r\n")) {
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (line.startsWith("PING")) {
      this.ws?.send(`PONG ${line.slice(5)}`);
      return;
    }
    const message = parsePrivmsg(line);
    if (message) this.bus.emit("twitch-message", { ...message });
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
    this.bus.emit("twitch-error", { message: `reconnecting in ${delay}ms` });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
