import type { EventBus } from "./bus.js";

export interface YoutubeOptions {
  /** Google API key with the YouTube Data v3 scope. */
  apiKey: string;
  /** The liveChatId of the stream being watched. */
  liveChatId: string;
  /** Minimum poll period in ms (YouTube's suggested interval wins if higher). */
  pollIntervalMs?: number;
  /** Test hook: inject a fetch implementation. */
  fetchImpl?: typeof fetch;
}

export interface YoutubeChatMessage {
  user: string;
  message: string;
  tags: {
    isOwner: boolean;
    isModerator: boolean;
    isMember: boolean;
  };
}

interface YoutubeItem {
  snippet?: { displayMessage?: string };
  authorDetails?: {
    displayName?: string;
    isChatOwner?: boolean;
    isChatModerator?: boolean;
    isChatSponsor?: boolean;
  };
}

interface YoutubeResponse {
  items?: YoutubeItem[];
  nextPageToken?: string;
  pollingIntervalMillis?: number;
}

const API_URL = "https://www.googleapis.com/youtube/v3/liveChat/messages";
const DEFAULT_POLL_MS = 15_000;

/**
 * Zero-dependency YouTube live chat ingest. Polls the Data v3
 * `liveChat.messages` endpoint and emits every message as a `youtube-message`
 * bus event (folded into the stream-context feed by the runtime). Honors the
 * API's suggested polling interval to avoid quota burn.
 */
export class YoutubeChat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pageToken: string | null = null;
  private running = false;
  private inFlight = false;
  private pollMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly bus: EventBus,
    private readonly options: YoutubeOptions,
  ) {
    this.pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private restartTimer(): void {
    if (!this.running) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try {
      const url = new URL(API_URL);
      url.searchParams.set("part", "snippet,authorDetails");
      url.searchParams.set("liveChatId", this.options.liveChatId);
      url.searchParams.set("key", this.options.apiKey);
      if (this.pageToken) url.searchParams.set("pageToken", this.pageToken);

      const res = await this.fetchImpl(url.toString());
      if (!res.ok) throw new Error(`YouTube API HTTP ${res.status}`);
      const data = (await res.json()) as YoutubeResponse;

      if (typeof data.pollingIntervalMillis === "number" && data.pollingIntervalMillis > this.pollMs) {
        this.pollMs = data.pollingIntervalMillis;
        this.restartTimer();
      }
      if (typeof data.nextPageToken === "string") this.pageToken = data.nextPageToken;

      for (const item of data.items ?? []) {
        const message = item.snippet?.displayMessage ?? "";
        if (!message) continue;
        this.bus.emit("youtube-message", {
          user: item.authorDetails?.displayName ?? "anon",
          message,
          tags: {
            isOwner: item.authorDetails?.isChatOwner === true,
            isModerator: item.authorDetails?.isChatModerator === true,
            isMember: item.authorDetails?.isChatSponsor === true,
          },
        });
      }
    } catch (err) {
      this.bus.emit("youtube-error", { message: (err as Error).message });
    } finally {
      this.inFlight = false;
    }
  }
}
