import type { AnimationCue } from "./expression.js";
import type { EventBus } from "./bus.js";

export type VtubeTargetKind = "hotkey" | "expression";

export interface VtubeTarget {
  kind: VtubeTargetKind;
  /** Hotkey name (e.g. "Circe Joy") or expression file name (e.g. "Joy.exp3.json"). */
  name: string;
}

export interface VtubeStudioOptions {
  host?: string;
  port?: number;
  pluginName?: string;
  pluginDeveloper?: string;
  /** VTS plugin auth token; omit and approve the plugin inside VTube Studio. */
  authToken?: string;
  /** Map cue expression keys (joy, pout, smug...) to hotkeys or expression files. */
  map?: Record<string, VtubeTarget>;
  /** Fallback target kind when an expression has no entry in `map`. */
  defaultKind?: VtubeTargetKind;
  /** Prefix for generated default target names, e.g. "circe_joy". */
  prefix?: string;
  /** How long (ms) an activated expression stays before the reset target fires. */
  holdMs?: number;
  /** Target name to revert to after holdMs; omit to leave the expression active. */
  reset?: string;
  /** Live model parameters to poll while connected, e.g. ["MouthOpen", "FaceAngleX"]. */
  pollParams?: string[];
  /** Poll period in ms (default 500). */
  pollIntervalMs?: number;
  /** Also poll the webcam face tracker (found, position, mouth/eye openness). */
  pollFace?: boolean;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Test hook: supply your own socket factory (defaults to the global WebSocket). */
  wsFactory?: (url: string) => VtubeSocket;
}

export type VtubeState = "disconnected" | "connecting" | "authenticating" | "ready";

export interface VtubeSocket {
  addEventListener(type: string, handler: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

interface VtubeMessage {
  apiName?: string;
  apiVersion?: string;
  timestamp?: number;
  requestID?: string;
  messageType?: string;
  data?: Record<string, unknown>;
}

interface Pending {
  resolve: (message: VtubeMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const API_NAME = "VTubeStudioPublicAPI";
const API_VERSION = "1.0";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_QUEUED_CUES = 100;

/**
 * Hotkey names are compared loosely so "Circe Joy" in the VTS model matches
 * the generated "circe_joy" target name.
 */
function normalizeHotkeyName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function defaultWs(url: string): VtubeSocket {
  if (typeof WebSocket === "undefined") {
    throw new Error("global WebSocket unavailable — Node 22.4+ required for the VTube Studio bridge");
  }
  return new WebSocket(url) as unknown as VtubeSocket;
}

/**
 * Bridge to the VTube Studio plugin API (WebSocket on :8001). Maps Circe's
 * animation cues onto VTS hotkeys or expression states:
 *
 *   expression cue ──► HotkeyTriggerRequest (name resolved via hotkey list)
 *                    or ExpressionStateRequest (expression file activation)
 *
 * Auth follows the VTS plugin flow: AuthenticationTokenRequest, then
 * AuthenticationRequest; without a stored token the user approves the plugin
 * inside VTube Studio. Reconnects with exponential backoff when VTS is down.
 * Every transition/error is emitted on the event bus as a `vtube*` event.
 */
export class VtubeStudioDriver {
  private ws: VtubeSocket | null = null;
  private state: VtubeState = "disconnected";
  private readonly pending = new Map<string, Pending>();
  private readonly queue: AnimationCue[] = [];
  private hotkeyIds = new Map<string, string>();
  private hotkeysLoaded = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private latestParams = new Map<string, number>();
  private latestFace: Record<string, unknown> | null = null;
  private requestSeq = 0;
  private reconnects = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: Required<
    Pick<
      VtubeStudioOptions,
      | "host"
      | "port"
      | "pluginName"
      | "pluginDeveloper"
      | "defaultKind"
      | "prefix"
      | "holdMs"
      | "reconnectBaseMs"
      | "reconnectMaxMs"
      | "pollParams"
      | "pollIntervalMs"
      | "pollFace"
    >
  > &
    Pick<VtubeStudioOptions, "authToken" | "map" | "reset"> & {
      wsFactory: (url: string) => VtubeSocket;
    };

  constructor(
    private readonly bus: EventBus,
    options: VtubeStudioOptions = {},
  ) {
    this.options = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 8001,
      pluginName: options.pluginName ?? "CirceCore",
      pluginDeveloper: options.pluginDeveloper ?? "circe",
      authToken: options.authToken,
      map: options.map,
      defaultKind: options.defaultKind ?? "hotkey",
      prefix: options.prefix ?? "circe_",
      holdMs: options.holdMs ?? 2500,
      reset: options.reset,
      pollParams: options.pollParams ?? [],
      pollIntervalMs: options.pollIntervalMs ?? 500,
      pollFace: options.pollFace ?? false,
      reconnectBaseMs: options.reconnectBaseMs ?? 1000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      wsFactory: options.wsFactory ?? defaultWs,
    };
  }

  get isReady(): boolean {
    return this.state === "ready";
  }

  /** Latest polled model parameters as a plain object. */
  params(): Record<string, number> {
    return Object.fromEntries(this.latestParams);
  }

  /** Latest webcam face snapshot, if face polling is enabled. */
  face(): Record<string, unknown> | null {
    return this.latestFace ? { ...this.latestFace } : null;
  }

  /** Connect and run the auth handshake. Safe to call repeatedly. */
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
    this.stopPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("driver stopped"));
    }
    this.pending.clear();
    this.queue.length = 0;
    this.ws?.close();
    this.ws = null;
    this.setState("disconnected");
  }

  /** Route a parsed animation cue to the mapped VTS hotkey or expression. */
  handleCue(cue: AnimationCue): void {
    const target = this.targetFor(cue.expression);
    const needsHotkeys = target.kind === "hotkey" && !this.hotkeysLoaded;
    if (!this.isReady || needsHotkeys) {
      if (this.queue.length < MAX_QUEUED_CUES) this.queue.push(cue);
      return;
    }
    this.trigger(target);
  }

  private connect(): void {
    this.setState("connecting");
    const url = `ws://${this.options.host}:${this.options.port}`;
    let socket: VtubeSocket;
    try {
      socket = this.options.wsFactory(url);
    } catch (err) {
      this.emitError(`cannot create socket: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    socket.addEventListener("open", () => this.onOpen());
    socket.addEventListener("message", (event: unknown) => {
      this.onMessage(this.readMessage(event));
    });
    socket.addEventListener("close", () => this.onClose());
    socket.addEventListener("error", () => {
      this.emitError("socket error");
    });
  }

  private onOpen(): void {
    this.setState("authenticating");
    void this.send("AuthenticationTokenRequest", {
      pluginName: this.options.pluginName,
      pluginDeveloper: this.options.pluginDeveloper,
      authenticationToken: this.options.authToken ?? "",
    })
      .then((response) => {
        const token = response.data?.authenticationToken;
        if (typeof token === "string" && token) {
          return this.send("AuthenticationRequest", {
            pluginName: this.options.pluginName,
            pluginDeveloper: this.options.pluginDeveloper,
            authenticationToken: token,
          });
        }
        this.emitError("no authentication token received");
        this.ws?.close();
        return response;
      })
      .then((response) => {
        if (response.data?.authenticated === true) {
          this.setState("ready");
          void this.refreshHotkeys();
        } else {
          this.emitError(`VTube Studio did not authenticate the plugin (${String(response.data?.reason ?? "unknown reason")})`);
          this.ws?.close();
        }
      })
      .catch((err: Error) => {
        this.emitError(err.message);
      });
  }

  private onMessage(message: VtubeMessage | null): void {
    if (!message) return;
    this.bus.emit("vtube-message", { messageType: message.messageType ?? "unknown" });
    if (message.messageType === "APIError") {
      const errorID = message.requestID;
      const pending = errorID ? this.pending.get(errorID) : undefined;
      if (pending) {
        this.pending.delete(errorID as string);
        clearTimeout(pending.timer);
        pending.reject(new Error(`VTS API error: ${String(message.data?.message ?? "unknown")}`));
      } else {
        this.emitError(`VTS API error: ${String(message.data?.message ?? "unknown")}`);
      }
      return;
    }
    if (message.messageType === "HotkeysInCurrentModelResponse") {
      this.hotkeyIds.clear();
      const hotkeys = message.data?.availableHotkeys;
      if (Array.isArray(hotkeys)) {
        for (const hotkey of hotkeys) {
          const name = (hotkey as { name?: string }).name;
          const id = (hotkey as { hotkeyID?: string }).hotkeyID;
          if (name && id) this.hotkeyIds.set(normalizeHotkeyName(name), id);
        }
      }
    }
    const requestID = message.requestID;
    if (!requestID) return;
    const pending = this.pending.get(requestID);
    if (!pending) return;
    this.pending.delete(requestID);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  private onClose(): void {
    this.ws = null;
    this.hotkeyIds.clear();
    this.hotkeysLoaded = false;
    this.stopPolling();
    this.rejectAll("socket closed");
    this.setState("disconnected");
    if (!this.closed) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(
      this.options.reconnectBaseMs * 2 ** this.reconnects,
      this.options.reconnectMaxMs,
    );
    this.reconnects += 1;
    this.bus.emit("vtube", { state: this.state, detail: `reconnecting in ${delay}ms` });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async refreshHotkeys(): Promise<void> {
    try {
      await this.send("HotkeysInCurrentModelRequest");
    } catch (err) {
      this.emitError(`hotkey refresh failed: ${(err as Error).message}`);
    } finally {
      this.hotkeysLoaded = true;
      this.flushQueue();
    }
  }

  private targetFor(expression: string): VtubeTarget {
    const mapped = this.options.map?.[expression];
    if (mapped) return mapped;
    return { kind: this.options.defaultKind, name: `${this.options.prefix}${expression}` };
  }

  private trigger(target: VtubeTarget): void {
    if (target.kind === "expression") {
      void this.send("ExpressionStateRequest", { expressionFile: target.name, active: true })
        .then(() => this.bus.emit("vtube-expression", { name: target.name, active: true }))
        .catch((err: Error) => this.emitError(err.message));
      if (this.options.reset && target.name !== this.options.reset) {
        this.scheduleReset(this.options.reset);
      }
      return;
    }
    const hotkeyId = this.hotkeyIds.get(normalizeHotkeyName(target.name));
    if (!hotkeyId) {
      this.emitError(`unknown hotkey "${target.name}" (model hotkey list not loaded or name mismatch)`);
      return;
    }
    void this.send("HotkeyTriggerRequest", { hotkeyID: hotkeyId })
      .then(() => this.bus.emit("vtube-hotkey", { name: target.name, hotkeyID: hotkeyId }))
      .catch((err: Error) => this.emitError(err.message));
    if (this.options.reset && target.name !== this.options.reset) {
      this.scheduleReset(this.options.reset);
    }
  }

  private flushQueue(): void {
    if (this.queue.length === 0) return;
    const queued = this.queue.splice(0);
    for (const cue of queued) this.handleCue(cue);
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    if (this.options.pollParams.length === 0 && !this.options.pollFace) return;
    this.pollTimer = setInterval(() => {
      if (!this.isReady) return;
      for (const name of this.options.pollParams) {
        void this.send("ParameterValueRequest", { name })
          .then((response) => {
            const value = response.data?.value;
            if (typeof value === "number") {
              this.latestParams.set(name, value);
              this.bus.emit("vtube-param", { name, value });
            }
          })
          .catch(() => {
            // transient misses during reconnect are not interesting
          });
      }
      if (this.options.pollFace) {
        void this.send("FaceFoundRequest")
          .then((response) => {
            if (response.data) {
              this.latestFace = response.data;
              this.bus.emit("vtube-face", { ...response.data });
            }
          })
          .catch(() => {
            // camera not configured — stay quiet
          });
      }
    }, this.options.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleReset(name: string): void {
    const timer = setTimeout(() => {
      this.trigger({ kind: this.options.defaultKind, name });
    }, this.options.holdMs);
    timer.unref?.();
  }

  private send(messageType: string, data: Record<string, unknown> = {}): Promise<VtubeMessage> {
    const requestID = `circe-${++this.requestSeq}`;
    const message: VtubeMessage = {
      apiName: API_NAME,
      apiVersion: API_VERSION,
      requestID,
      messageType,
      data,
    };
    if (!this.ws) {
      return Promise.reject(new Error(`cannot send ${messageType}: not connected`));
    }
    const socket = this.ws;
    return new Promise<VtubeMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestID);
        reject(new Error(`${messageType} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestID, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify(message));
      } catch (err) {
        this.pending.delete(requestID);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  private rejectAll(reason: string): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private readMessage(event: unknown): VtubeMessage | null {
    try {
      const data = (event as { data?: unknown }).data;
      if (typeof data !== "string") return null;
      return JSON.parse(data) as VtubeMessage;
    } catch {
      return null;
    }
  }

  private setState(state: VtubeState): void {
    if (this.state === state) return;
    this.state = state;
    this.bus.emit("vtube", { state });
    if (state === "ready") {
      this.reconnects = 0;
      this.startPolling();
    }
  }

  private emitError(message: string): void {
    this.bus.emit("vtube-error", { message });
  }
}
