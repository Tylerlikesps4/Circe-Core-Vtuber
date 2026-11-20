// Speech output: phone voice (expo-speech) or the PC's neural voice via the
// runtime's GET/POST /tts gateway, played in order with expo-av. Sentences are
// queued; PC audio is fetched ahead while the previous sentence plays, and any
// PC failure falls back to the phone voice (PC is skipped for 30s after).
import * as Speech from "expo-speech";
import { Audio } from "expo-av";
import { parseReply } from "./expression";

export interface VoiceSettings {
  voiceId: string; // expo-speech identifier ("" = system default)
  pitch: number;
  rate: number;
  pcVoice: boolean; // use PC neural voice via /tts
  pcVoiceName: string; // optional backend voice override, e.g. en-US-AriaNeural
}

export type PhoneVoice = Speech.Voice;

// Google TTS female English voices, best first (network = cloud quality).
const PREFERRED = ["en-us-x-sfg", "en-us-x-tpc", "en-us-x-iog", "en-us-x-tpf", "en-gb-x-gba", "en-gb-x-gbc", "en-gb-x-gbg"];

const isEn = (v: PhoneVoice) => /^en/i.test(v.language);
const isNet = (v: PhoneVoice) => /network/i.test(v.identifier);
const isHq = (v: PhoneVoice) => String(v.quality) === "Enhanced";

export function sortVoices(voices: PhoneVoice[]): PhoneVoice[] {
  const score = (v: PhoneVoice) => (isEn(v) ? 0 : 100) - (isHq(v) ? 10 : 0) - (isNet(v) ? 5 : 0) - (/en-us/i.test(v.language) ? 1 : 0);
  return [...voices].sort((a, b) => score(a) - score(b) || a.identifier.localeCompare(b.identifier));
}

export async function listVoices(): Promise<PhoneVoice[]> {
  try {
    return sortVoices(await Speech.getAvailableVoicesAsync());
  } catch {
    return [];
  }
}

/** Pick a good English female default if the device has one. */
export function pickDefaultVoice(voices: PhoneVoice[]): string {
  for (const suffix of ["-network", "-local"]) {
    for (const p of PREFERRED) {
      const v = voices.find((x) => x.identifier.toLowerCase().startsWith(p) && x.identifier.toLowerCase().includes(suffix));
      if (v) return v.identifier;
    }
  }
  const en = voices.find((v) => isEn(v) && isHq(v)) ?? voices.find(isEn);
  return en?.identifier ?? "";
}

export function hostBase(host: string): string {
  return "http://" + host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

type Item = { text: string; sound?: Promise<Audio.Sound | null> };

export class Speaker {
  private queue: Item[] = [];
  private running = false;
  private gen = 0;
  private pcDownUntil = 0;
  private current: Audio.Sound | null = null;
  onNote?: (msg: string) => void;

  constructor(private v: VoiceSettings, private host: string) {
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true, staysActiveInBackground: false }).catch(() => {});
  }

  configure(v: VoiceSettings, host: string) {
    this.v = v;
    this.host = host;
  }

  /** Queue one sentence (markers/asides are stripped). */
  say(raw: string) {
    const text = parseReply(raw).speech.trim();
    if (!/[A-Za-z0-9]/.test(text)) return;
    const item: Item = { text };
    if (this.usePc()) item.sound = this.loadPc(text);
    this.queue.push(item);
    if (!this.running) this.pump(this.gen);
  }

  stop() {
    this.gen++;
    const pending = this.queue;
    this.queue = [];
    this.running = false;
    for (const it of pending) it.sound?.then((s) => s?.unloadAsync()).catch(() => {});
    this.current?.stopAsync().catch(() => {});
    this.current?.unloadAsync().catch(() => {});
    this.current = null;
    Speech.stop();
  }

  private usePc() {
    return this.v.pcVoice && Date.now() > this.pcDownUntil;
  }

  private async loadPc(text: string): Promise<Audio.Sound | null> {
    const q = `text=${encodeURIComponent(text.slice(0, 1000))}` + (this.v.pcVoiceName ? `&voice=${encodeURIComponent(this.v.pcVoiceName)}` : "");
    try {
      const { sound } = await Audio.Sound.createAsync({ uri: `${hostBase(this.host)}/tts?${q}` }, { shouldPlay: false });
      return sound;
    } catch (e) {
      this.pcDownUntil = Date.now() + 30_000;
      this.onNote?.(`PC voice unreachable, using phone voice (${String((e as Error).message).slice(0, 60)})`);
      return null;
    }
  }

  private async pump(gen: number) {
    this.running = true;
    while (gen === this.gen && this.queue.length) {
      const it = this.queue.shift()!;
      const sound = it.sound ? await it.sound : null;
      if (gen !== this.gen) {
        sound?.unloadAsync().catch(() => {});
        break;
      }
      if (sound) await this.playSound(sound);
      else await this.speakPhone(it.text);
    }
    if (gen === this.gen) this.running = false;
  }

  private playSound(sound: Audio.Sound): Promise<void> {
    this.current = sound;
    return new Promise((resolve) => {
      const done = () => {
        sound.setOnPlaybackStatusUpdate(null);
        sound.unloadAsync().catch(() => {});
        if (this.current === sound) this.current = null;
        resolve();
      };
      sound.setOnPlaybackStatusUpdate((st) => {
        if (!st.isLoaded) return st.error ? done() : undefined;
        if (st.didJustFinish) done();
      });
      sound.playAsync().catch(done);
    });
  }

  speakPhone(text: string): Promise<void> {
    return new Promise((resolve) => {
      Speech.speak(text, {
        ...(this.v.voiceId ? { voice: this.v.voiceId } : {}),
        pitch: this.v.pitch,
        rate: this.v.rate,
        onDone: () => resolve(),
        onStopped: () => resolve(),
        onError: () => resolve(),
      });
    });
  }
}

/** Incremental sentence splitter over a growing (think-stripped) text. */
export class SentenceFeed {
  private spoken = 0;
  constructor(private emit: (s: string) => void) {}
  update(full: string) {
    const rest = full.slice(this.spoken);
    const re = /[^.!?…\n]*[.!?…]+["')\]]*(\s+|$)|[^\n]*\n/g;
    let m: RegExpExecArray | null;
    let used = 0;
    while ((m = re.exec(rest)) && m[0].length) {
      // only accept terminators followed by whitespace (sentence really ended)
      if (!/\s$/.test(m[0])) break;
      used = re.lastIndex;
      if (m[0].trim()) this.emit(m[0].trim());
    }
    this.spoken += used;
  }
  flush(full: string) {
    const tail = full.slice(this.spoken).trim();
    this.spoken = full.length;
    if (tail) this.emit(tail);
  }
  reset() {
    this.spoken = 0;
  }
}
