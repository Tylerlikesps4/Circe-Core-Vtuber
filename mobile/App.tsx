import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as Speech from "expo-speech";
import { C } from "./src/theme";
import { parseReply, stripThink, Cue } from "./src/expression";
import { SYSTEM_PROMPT } from "./src/persona";
import { chatStream, postJson, sseRequest, StreamHandle } from "./src/net";
import {
  DEFAULT_SETTINGS,
  Msg,
  PRESETS,
  Settings,
  loadApiKey,
  loadHistory,
  loadNotes,
  loadSettings,
  saveApiKey,
  saveHistory,
  saveNotes,
  saveSettings,
} from "./src/storage";

type Tab = "circe" | "settings";

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<Tab>("circe");
  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...(s ?? DEFAULT_SETTINGS), ...patch };
      saveSettings(next);
      return next;
    });
  }, []);
  if (!settings) return <View style={st.root} />;
  return (
    <SafeAreaView style={st.root}>
      <StatusBar style="light" />
      <View style={st.header}>
        <Text style={st.title}>✦ CIRCE-CORE</Text>
        <View style={st.row}>
          <Seg label="Remote" on={settings.mode === "remote"} onPress={() => update({ mode: "remote" })} />
          <Seg label="Standalone" on={settings.mode === "standalone"} onPress={() => update({ mode: "standalone" })} />
          <Seg label="⚙" on={tab === "settings"} onPress={() => setTab(tab === "settings" ? "circe" : "settings")} />
        </View>
      </View>
      {tab === "settings" ? (
        <SettingsScreen s={settings} update={update} />
      ) : settings.mode === "remote" ? (
        <RemoteScreen s={settings} />
      ) : (
        <StandaloneScreen s={settings} />
      )}
    </SafeAreaView>
  );
}

function Seg({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[st.seg, on && st.segOn]}>
      <Text style={[st.segText, on && { color: C.bg }]}>{label}</Text>
    </Pressable>
  );
}

function Chips({ cues }: { cues: Cue[] }) {
  if (!cues.length) return null;
  return (
    <View style={[st.row, { flexWrap: "wrap", marginTop: 4 }]}>
      {cues.map((c, i) => (
        <Text key={i} style={st.chip}>
          {c.mood} · {c.marker}
        </Text>
      ))}
    </View>
  );
}

function Composer({ onSend, busy, placeholder }: { onSend: (t: string) => void; busy?: boolean; placeholder: string }) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    onSend(t);
  };
  return (
    <View style={st.composer}>
      <TextInput
        style={st.input}
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={C.dim}
        onSubmitEditing={send}
        returnKeyType="send"
      />
      <Pressable style={[st.btn, busy && { opacity: 0.5 }]} onPress={send}>
        <Text style={st.btnText}>{busy ? "…" : "Send"}</Text>
      </Pressable>
    </View>
  );
}

/* ---------------- Standalone: Circe runs on the phone ---------------- */

function StandaloneScreen({ s }: { s: Settings }) {
  const [history, setHistory] = useState<Msg[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const handle = useRef<StreamHandle | null>(null);
  useEffect(() => {
    loadHistory().then(setHistory);
    return () => handle.current?.abort();
  }, []);

  const send = async (text: string) => {
    setErr("");
    if (text.startsWith("/remember ")) {
      const notes = await loadNotes();
      await saveNotes([...notes, text.slice(10).trim()]);
      setErr("✓ noted in memory");
      return;
    }
    const apiKey = await loadApiKey(s.preset);
    const notes = await loadNotes();
    const userMsg: Msg = { role: "user", content: text, ts: Date.now() };
    const next = [...history, userMsg];
    setHistory(next);
    saveHistory(next);
    const system =
      SYSTEM_PROMPT +
      (notes.length ? `\n\n## Things you remember about ${s.userName}\n- ${notes.join("\n- ")}` : "") +
      `\n\nYou are chatting one-on-one with ${s.userName} on their phone.`;
    const messages = [
      { role: "system", content: system },
      ...next.slice(-20).map((m) => ({ role: m.role, content: m.content })),
    ];
    let acc = "";
    setDraft("");
    handle.current = chatStream({
      baseUrl: s.baseUrl,
      apiKey,
      model: s.model,
      messages,
      onToken: (t) => {
        acc += t;
        setDraft(stripThink(acc));
      },
      onDone: (e) => {
        handle.current = null;
        setDraft(null);
        const reply = stripThink(acc).trim();
        if (e && !reply) {
          setErr(e);
          return;
        }
        if (!reply) return;
        const done = [...next, { role: "assistant" as const, content: reply, ts: Date.now() }];
        setHistory(done);
        saveHistory(done);
        if (s.tts) {
          const { speech } = parseReply(reply);
          if (speech) Speech.speak(speech, { pitch: 1.1, rate: 1.0 });
        }
      },
    });
  };

  const data = draft !== null ? [...history, { role: "assistant" as const, content: draft || "…", ts: -1 }] : history;
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Text style={st.sub}>
        {s.preset} · {s.model}
      </Text>
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12 }}
        data={[...data].reverse()}
        inverted
        keyExtractor={(m, i) => `${m.ts}-${i}`}
        renderItem={({ item }) => {
          const parsed = item.role === "assistant" ? parseReply(item.content) : null;
          return (
            <View style={[st.bubble, item.role === "user" ? st.userBubble : st.circeBubble]}>
              <Text style={st.text}>{parsed ? parsed.speech || item.content : item.content}</Text>
              {parsed && <Chips cues={parsed.cues} />}
            </View>
          );
        }}
      />
      {!!err && <Text style={st.err}>{err}</Text>}
      <View style={[st.row, { paddingHorizontal: 12 }]}>
        <Pressable
          onPress={() => {
            Speech.stop();
            handle.current?.abort();
            setDraft(null);
          }}
        >
          <Text style={st.link}>stop</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            setHistory([]);
            saveHistory([]);
          }}
        >
          <Text style={st.link}>clear chat</Text>
        </Pressable>
        <Text style={st.hint}>/remember … saves a memory note</Text>
      </View>
      <Composer onSend={send} busy={draft !== null} placeholder="Talk to Circe…" />
    </KeyboardAvoidingView>
  );
}

/* ---------------- Remote: control Circe on the PC ---------------- */

interface FeedItem {
  seq: number;
  type: string;
  text: string;
}
const CUES = ["giggles", "smirks", "pouts", "gasps", "sighs", "hums", "waves", "tilts head"];

function describe(ev: any): string {
  switch (ev.type) {
    case "chat":
      return `${ev.user}: ${ev.message}`;
    case "speech":
      return `Circe: ${ev.text}`;
    case "expression":
      return `✧ ${ev.marker} → ${ev.expression} (${ev.mood})`;
    case "metrics":
      return `context ${ev.contextUsed}/${ev.contextTotal}`;
    default: {
      const { type, seq, ts, ...rest } = ev;
      const s = JSON.stringify(rest);
      return s.length > 160 ? s.slice(0, 160) + "…" : s;
    }
  }
}

function RemoteScreen({ s }: { s: Settings }) {
  const base = "http://" + s.remoteHost.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const [status, setStatus] = useState("disconnected");
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [mood, setMood] = useState("—");
  const [mana, setMana] = useState<any>(null);
  const [askMode, setAskMode] = useState(true);
  const [busy, setBusy] = useState(false);
  const sse = useRef<StreamHandle | null>(null);
  const lastSeq = useRef(0);
  const want = useRef(false);

  const connect = useCallback(() => {
    sse.current?.abort();
    want.current = true;
    setStatus("connecting…");
    sse.current = sseRequest({
      url: `${base}/events?since=${lastSeq.current}`,
      headers: { Accept: "text/event-stream" },
      onData: (data) => {
        setStatus("live");
        try {
          const ev = JSON.parse(data);
          if (typeof ev.seq === "number") lastSeq.current = Math.max(lastSeq.current, ev.seq);
          if (ev.type === "expression") setMood(`${ev.mood} · ${ev.expression}`);
          setFeed((f) => [{ seq: ev.seq ?? Date.now(), type: ev.type, text: describe(ev) }, ...f].slice(0, 200));
        } catch {
          /* ignore */
        }
      },
      onDone: (e) => {
        setStatus(e ? `offline (${e.slice(0, 60)})` : "closed");
        if (want.current) setTimeout(() => want.current && connect(), 3000);
      },
    });
  }, [base]);

  useEffect(() => {
    const poll = setInterval(async () => {
      if (!want.current) return;
      try {
        const r = await fetch(`${base}/mana`);
        if (r.ok) setMana(await r.json());
      } catch {
        /* offline */
      }
    }, 5000);
    return () => {
      clearInterval(poll);
      want.current = false;
      sse.current?.abort();
    };
  }, [base]);

  const disconnect = () => {
    want.current = false;
    sse.current?.abort();
    setStatus("disconnected");
  };

  const send = async (text: string) => {
    setBusy(true);
    try {
      if (askMode) await postJson(`${base}/ask`, { message: text });
      else await postJson(`${base}/chat`, { user: s.userName || "phone", message: text });
    } catch (e) {
      setFeed((f) => [{ seq: Date.now(), type: "error", text: `send failed: ${(e as Error).message}` }, ...f]);
    } finally {
      setBusy(false);
    }
  };

  const cue = (marker: string) =>
    postJson(`${base}/cue`, { marker }).catch((e) =>
      setFeed((f) => [{ seq: Date.now(), type: "error", text: `cue failed: ${(e as Error).message}` }, ...f]),
    );

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const manaRatio = mana?.context?.total ? 1 - mana.context.used / mana.context.total : null;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }}>
      <View style={[st.row, { padding: 12, justifyContent: "space-between" }]}>
        <Text style={st.sub}>
          {base} · <Text style={{ color: status === "live" ? C.teal : C.danger }}>{status}</Text>
        </Text>
        <Pressable style={st.btnSmall} onPress={want.current ? disconnect : connect}>
          <Text style={st.btnText}>{want.current ? "Disconnect" : "Connect"}</Text>
        </Pressable>
      </View>
      <View style={st.card}>
        <Text style={st.label}>Mood: <Text style={{ color: C.purple }}>{mood}</Text></Text>
        {mana ? (
          <>
            <Text style={st.label}>
              CPU {pct(mana.cpu?.load ?? 0)} · RAM {mana.memory ? pct(mana.memory.used / mana.memory.total) : "?"}
              {mana.gpu ? ` · GPU ${mana.gpu.util}%` : ""}
            </Text>
            {manaRatio !== null && (
              <View style={st.meter}>
                <View style={[st.meterFill, { width: `${Math.max(0, Math.min(1, manaRatio)) * 100}%` }]} />
              </View>
            )}
            <Text style={st.hint}>{manaRatio !== null ? `mana ${pct(manaRatio)} (context left)` : "mana: no context metrics yet"}</Text>
          </>
        ) : (
          <Text style={st.hint}>mana pool: waiting for /mana</Text>
        )}
      </View>
      <ScrollView horizontal style={{ maxHeight: 44, paddingHorizontal: 8 }}>
        {CUES.map((c) => (
          <Pressable key={c} style={st.cueBtn} onPress={() => cue(c)}>
            <Text style={st.chipText}>*{c}*</Text>
          </Pressable>
        ))}
      </ScrollView>
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12 }}
        data={feed}
        keyExtractor={(f, i) => `${f.seq}-${i}`}
        renderItem={({ item }) => (
          <Text style={[st.feed, item.type === "speech" && { color: C.teal }, item.type === "error" && { color: C.danger }]}>
            <Text style={{ color: C.dim }}>[{item.type}] </Text>
            {item.text}
          </Text>
        )}
      />
      <View style={[st.row, { paddingHorizontal: 12 }]}>
        <Text style={st.hint}>{askMode ? "Ask Circe (/ask)" : "Viewer chat (/chat)"}</Text>
        <Switch value={askMode} onValueChange={setAskMode} thumbColor={askMode ? C.teal : C.dim} />
      </View>
      <Composer onSend={send} busy={busy} placeholder="Message Circe on the PC…" />
    </KeyboardAvoidingView>
  );
}

/* ---------------- Settings ---------------- */

function SettingsScreen({ s, update }: { s: Settings; update: (p: Partial<Settings>) => void }) {
  const [key, setKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  useEffect(() => {
    loadApiKey(s.preset).then((k) => {
      setKeySaved(!!k);
      setKey("");
    });
  }, [s.preset]);
  useEffect(() => {
    loadNotes().then(setNotes);
  }, []);
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Text style={st.h2}>Remote (PC runtime)</Text>
      <Text style={st.hint}>Run Circe with CIRCE_HOST=0.0.0.0 so the phone can reach port 8788 on your LAN.</Text>
      <Field label="PC host:port" value={s.remoteHost} onChange={(v) => update({ remoteHost: v.trim() })} />

      <Text style={st.h2}>Standalone brain</Text>
      <View style={[st.row, { flexWrap: "wrap" }]}>
        {Object.keys(PRESETS).map((p) => (
          <Seg key={p} label={p} on={s.preset === p} onPress={() => update({ preset: p, ...PRESETS[p] })} />
        ))}
      </View>
      <Field label="Base URL (OpenAI-compatible)" value={s.baseUrl} onChange={(v) => update({ baseUrl: v.trim() })} />
      <Field label="Model" value={s.model} onChange={(v) => update({ model: v.trim() })} />
      <Text style={st.label}>API key for {s.preset} {keySaved ? "(saved securely)" : "(none)"}</Text>
      <View style={st.composer}>
        <TextInput
          style={st.input}
          value={key}
          onChangeText={setKey}
          secureTextEntry
          placeholder={keySaved ? "•••••• (enter to replace)" : "not needed for Ollama"}
          placeholderTextColor={C.dim}
        />
        <Pressable
          style={st.btn}
          onPress={async () => {
            await saveApiKey(s.preset, key.trim());
            setKeySaved(!!key.trim());
            setKey("");
          }}
        >
          <Text style={st.btnText}>{key.trim() ? "Save" : "Clear"}</Text>
        </Pressable>
      </View>
      <Field label="Your name" value={s.userName} onChange={(v) => update({ userName: v })} />
      <View style={[st.row, { justifyContent: "space-between", marginVertical: 8 }]}>
        <Text style={st.label}>Speak replies (Android TTS)</Text>
        <Switch value={s.tts} onValueChange={(v) => update({ tts: v })} thumbColor={s.tts ? C.teal : C.dim} />
      </View>

      <Text style={st.h2}>Memory notes ({notes.length})</Text>
      {notes.map((n, i) => (
        <View key={i} style={[st.row, { justifyContent: "space-between" }]}>
          <Text style={[st.text, { flex: 1 }]}>• {n}</Text>
          <Pressable
            onPress={() => {
              const next = notes.filter((_, j) => j !== i);
              setNotes(next);
              saveNotes(next);
            }}
          >
            <Text style={st.link}>✕</Text>
          </Pressable>
        </View>
      ))}
      <Text style={st.hint}>Add notes from chat with “/remember …”.</Text>
      <Text style={[st.hint, { marginTop: 24 }]}>Circe-Core mobile v0.1.0</Text>
    </ScrollView>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <View style={{ marginVertical: 6 }}>
      <Text style={st.label}>{label}</Text>
      <TextInput
        style={st.input}
        value={v}
        onChangeText={setV}
        onEndEditing={() => onChange(v)}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={C.dim}
      />
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === "android" ? 28 : 0 },
  header: { padding: 12, borderBottomWidth: 1, borderColor: C.border, gap: 8 },
  title: { color: C.teal, fontSize: 20, fontWeight: "800", letterSpacing: 3 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  seg: { borderWidth: 1, borderColor: C.purple, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 5, marginVertical: 2 },
  segOn: { backgroundColor: C.purple },
  segText: { color: C.purple, fontWeight: "600" },
  sub: { color: C.dim, fontSize: 12, paddingHorizontal: 12, paddingTop: 6 },
  bubble: { padding: 10, borderRadius: 12, marginVertical: 4, maxWidth: "88%" },
  userBubble: { alignSelf: "flex-end", backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border },
  circeBubble: { alignSelf: "flex-start", backgroundColor: C.panel, borderWidth: 1, borderColor: C.teal },
  text: { color: C.text, fontSize: 15 },
  chip: { color: C.bg, backgroundColor: C.purple, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, fontSize: 11, overflow: "hidden" },
  chipText: { color: C.teal, fontSize: 12 },
  cueBtn: { borderWidth: 1, borderColor: C.teal, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6, marginRight: 6, height: 32 },
  composer: { flexDirection: "row", padding: 10, gap: 8, alignItems: "center" },
  input: { flex: 1, color: C.text, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  btn: { backgroundColor: C.teal, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  btnSmall: { backgroundColor: C.teal, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  btnText: { color: C.bg, fontWeight: "700" },
  err: { color: C.danger, paddingHorizontal: 12 },
  link: { color: C.purple, paddingVertical: 4, paddingRight: 8 },
  hint: { color: C.dim, fontSize: 12 },
  label: { color: C.text, fontSize: 13, marginBottom: 4 },
  h2: { color: C.teal, fontSize: 16, fontWeight: "700", marginTop: 16, marginBottom: 6 },
  card: { marginHorizontal: 12, padding: 12, backgroundColor: C.panel, borderRadius: 12, borderWidth: 1, borderColor: C.border },
  meter: { height: 10, backgroundColor: C.panel2, borderRadius: 5, overflow: "hidden", marginTop: 6 },
  meterFill: { height: 10, backgroundColor: C.purple },
  feed: { color: C.text, fontSize: 13, marginVertical: 2 },
});
