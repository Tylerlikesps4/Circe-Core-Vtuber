import { classifyMarker, AnimationCue } from "./expression.js";
import type { TtsResult } from "./tts.js";

export interface StreamSpeechOptions {
  /** Speak one flushed sentence; must resolve with the TTS result (never throw). */
  speak: (text: string) => Promise<TtsResult>;
  /** Fired the instant a `*marker*` completes mid-stream. */
  onCue?: (cue: AnimationCue) => void;
  /** Force-flush the pending text once it exceeds this many chars (default 200). */
  maxChars?: number;
}

const SENTENCE_ENDERS = new Set([".", "!", "?", "…", "~"]);
const CLOSING_CHARS = new Set(['"', "'", "’", ")", "]", "”"]);

/**
 * Incremental speech splitter for streaming replies. Feed token deltas with
 * `feed()`; it strips `*markers*` as they complete (emitting cues), flushes
 * finished sentences to TTS in order the moment a boundary arrives, and
 * `flush()` speaks whatever is left. Sentences are spoken sequentially so
 * file-writing backends and playback never overlap.
 */
export class StreamingSpeech {
  private buffer = "";
  private marker = "";
  private inMarker = false;
  private chain: Promise<void> = Promise.resolve();
  private finished = false;
  private readonly sentences: string[] = [];
  private readonly cueList: AnimationCue[] = [];
  private lastTts: TtsResult | null = null;
  private readonly maxChars: number;

  constructor(private readonly options: StreamSpeechOptions) {
    this.maxChars = options.maxChars ?? 200;
  }

  /** Feed one token delta from the brain stream. */
  feed(chunk: string): void {
    if (this.finished || typeof chunk !== "string") return;
    for (const char of chunk) {
      if (char === "*") {
        if (this.inMarker) {
          const marker = this.marker.trim();
          this.marker = "";
          this.inMarker = false;
          if (marker) {
            const cue = classifyMarker(marker);
            this.cueList.push(cue);
            this.options.onCue?.(cue);
          }
        } else {
          this.inMarker = true;
        }
      } else if (this.inMarker) {
        this.marker += char;
      } else {
        this.buffer += char;
        this.flushReady();
      }
    }
  }

  /** Flush everything pending and resolve once all sentences were spoken. */
  async flush(): Promise<void> {
    if (this.finished) return this.chain;
    this.finished = true;
    if (this.inMarker) {
      // An unclosed marker at end-of-stream is treated as literal speech.
      this.buffer += "*" + this.marker;
      this.marker = "";
      this.inMarker = false;
    }
    this.enqueue(this.buffer);
    this.buffer = "";
    await this.chain;
  }

  /** All flushed sentences joined back into the marker-stripped speech text. */
  speechText(): string {
    return this.sentences.join(" ");
  }

  /** Cues collected so far (or all, after flush). */
  cues(): AnimationCue[] {
    return [...this.cueList];
  }

  /** TTS result of the last spoken sentence, if any. */
  tts(): TtsResult | null {
    return this.lastTts;
  }

  /** How many sentences were flushed to TTS so far. */
  sentenceCount(): number {
    return this.sentences.length;
  }

  private flushReady(): void {
    const text = this.buffer;
    let cut = -1;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === "\n" || SENTENCE_ENDERS.has(char)) {
        const next = text[i + 1];
        if (next === undefined || /\s/.test(next) || CLOSING_CHARS.has(next)) {
          cut = i + 1;
          while (cut < text.length && CLOSING_CHARS.has(text[cut])) cut++;
          break;
        }
      }
    }
    if (cut === -1 && text.length > this.maxChars) {
      // No punctuation in sight: cut at the last word boundary so speech
      // still starts instead of stalling on a rambling sentence.
      const idx = text.lastIndexOf(" ", this.maxChars);
      cut = idx > 0 ? idx : this.maxChars;
    }
    if (cut === -1) return;
    this.enqueue(text.slice(0, cut));
    this.buffer = text.slice(cut);
  }

  private enqueue(raw: string): void {
    const text = raw.replace(/[ \t]{2,}/g, " ").trim();
    if (!text) return;
    this.sentences.push(text);
    this.chain = this.chain
      .then(() => this.options.speak(text))
      .then((tts) => {
        this.lastTts = tts;
      })
      .catch(() => undefined); // TTS hiccups must never break the chain
  }
}
