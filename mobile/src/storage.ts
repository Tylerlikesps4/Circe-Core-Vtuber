import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

export type Mode = "remote" | "standalone";
export interface Settings {
  mode: Mode;
  remoteHost: string; // e.g. 192.168.1.20:8788
  preset: string;
  baseUrl: string;
  model: string;
  tts: boolean;
  userName: string;
  voiceId: string; // phone voice identifier ("" = auto-pick on first launch)
  voiceAuto: boolean; // true until a default has been chosen
  pitch: number;
  rate: number;
  pcVoice: boolean; // speak via the PC runtime's /tts neural voice
  pcVoiceName: string; // optional override, e.g. en-GB-SoniaNeural
  remoteSpeak: boolean; // Remote mode: play the runtime's speech on the phone
}
export interface Msg {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export const PRESETS: Record<string, { baseUrl: string; model: string }> = {
  "PC Ollama (LAN)": { baseUrl: "http://192.168.1.10:11434/v1", model: "qwen3:8b" },
  OpenRouter: { baseUrl: "https://openrouter.ai/api/v1", model: "google/gemma-4-31b-it:free" },
  OpenAI: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  Groq: { baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.1-8b-instant" },
};

// Free OpenRouter chat models (ids ending in :free, from /api/v1/models, Nov 2026).
export const MODEL_CHIPS: Record<string, string[]> = {
  OpenRouter: [
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3.5-lightning:free",
    "inclusionai/ling-3.2-flash:free",
    "baidu/ernie-5.5-flash-preview:free",
  ],
};

export const DEFAULT_SETTINGS: Settings = {
  mode: "standalone",
  remoteHost: "192.168.1.10:8788",
  preset: "PC Ollama (LAN)",
  ...PRESETS["PC Ollama (LAN)"],
  tts: true,
  userName: "Anu",
  voiceId: "",
  voiceAuto: true,
  pitch: 1.05,
  rate: 1.0,
  pcVoice: false,
  pcVoiceName: "",
  remoteSpeak: false,
};

const K = { settings: "circe.settings", history: "circe.history", notes: "circe.notes" };

async function getJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? { ...(fallback as object), ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export const loadSettings = () => getJson<Settings>(K.settings, DEFAULT_SETTINGS);
export const saveSettings = (s: Settings) => AsyncStorage.setItem(K.settings, JSON.stringify(s));

export async function loadHistory(): Promise<Msg[]> {
  try {
    const raw = await AsyncStorage.getItem(K.history);
    return raw ? (JSON.parse(raw) as Msg[]) : [];
  } catch {
    return [];
  }
}
export const saveHistory = (h: Msg[]) => AsyncStorage.setItem(K.history, JSON.stringify(h.slice(-200)));

export async function loadNotes(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(K.notes);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
export const saveNotes = (n: string[]) => AsyncStorage.setItem(K.notes, JSON.stringify(n.slice(-50)));

// API keys live only in the Android keystore-backed SecureStore, one per preset.
const keyName = (preset: string) => "circe_key_" + preset.replace(/[^A-Za-z0-9]/g, "_");
export const loadApiKey = async (preset: string) => (await SecureStore.getItemAsync(keyName(preset))) ?? "";
export const saveApiKey = (preset: string, v: string) =>
  v ? SecureStore.setItemAsync(keyName(preset), v) : SecureStore.deleteItemAsync(keyName(preset));
