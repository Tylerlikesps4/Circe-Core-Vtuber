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
}
export interface Msg {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export const PRESETS: Record<string, { baseUrl: string; model: string }> = {
  "PC Ollama (LAN)": { baseUrl: "http://192.168.1.10:11434/v1", model: "qwen3:8b" },
  OpenRouter: { baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.1-8b-instruct" },
  OpenAI: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  Groq: { baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.1-8b-instant" },
};

export const DEFAULT_SETTINGS: Settings = {
  mode: "standalone",
  remoteHost: "192.168.1.10:8788",
  preset: "PC Ollama (LAN)",
  ...PRESETS["PC Ollama (LAN)"],
  tts: true,
  userName: "Anu",
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
