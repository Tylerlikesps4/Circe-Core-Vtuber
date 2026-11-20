import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CirceEvent {
  type: string;
  seq: number;
  ts: number;
  [key: string]: unknown;
}

type Handler = (event: CirceEvent) => void;

/**
 * Central event bus for the Circe runtime. Every typed event (chat, game,
 * speech, expression, tts) flows through here so external bridges — the
 * VTuber animation model, TTS layer, or a stream overlay — can subscribe to
 * one stream instead of being wired to each component.
 */
export class EventBus {
  private seq = 0;
  private handlers = new Set<Handler>();
  private history: CirceEvent[] = [];
  private readonly file?: string;
  private readonly maxHistory: number;

  constructor(options: { logFile?: string; maxHistory?: number } = {}) {
    this.file = options.logFile;
    this.maxHistory = options.maxHistory ?? 1000;
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
      } catch {
        // persistence remains best-effort if the directory cannot be created
      }
    }
  }

  emit(type: string, data: Record<string, unknown> = {}): CirceEvent {
    const event = { ...data, type, seq: ++this.seq, ts: Date.now() } as CirceEvent;
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.shift();
    if (this.file) {
      try {
        appendFileSync(this.file, JSON.stringify(event) + "\n");
      } catch {
        // best-effort persistence; never let logging break the pipeline
      }
    }
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch {
        // isolate handler failures so one bad subscriber cannot crash the bus
      }
    }
    return event;
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  since(seq: number): CirceEvent[] {
    return this.history.filter((event) => event.seq > seq);
  }

  snapshot(): CirceEvent[] {
    return [...this.history];
  }
}
