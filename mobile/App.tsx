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
import Slider from "@react-native-community/slider";
import { Speaker, SentenceFeed, PhoneVoice, listVoices, pickDefaultVoice } from "./src/voice";
import { C } from "./src/theme";
import { parseReply, stripThink, Cue } from "./src/expression";
import { SYSTEM_PROMPT } from "./src/persona";
import { chatStream, postJson, sseRequest, StreamHandle } from "./src/net";
import {
  DEFAULT_SETTINGS,
  MODEL_CHIPS,
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

const voiceOf = (s: Settings) => ({ voiceId: s.voiceId, pitch: s.pitch, rate: s.rate, pcVoice: s.pcVoice, pcVoiceName: s.pcVoiceName });

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<Tab>("circe");
  const speaker = useRef<Speaker | null>(null);
  const [voiceNote, setVoiceNote] = useState("");
  useEffect(() => {
    loadSettings().then(async (loaded) => {
      if (loaded.voiceAuto) {
        const id = pickDefaultVoice(await listVoices());
        loaded = { ...loaded, voiceId: id || loaded.voiceId, voiceAuto: false };
        saveSettings(loaded);
      }
      setSettings(loaded);
    });
  }, []);
  if (settings) {
    if (!speaker.current) {
      speaker.current = new Speaker(voiceOf(settings), settings.remoteHost);
      speaker.current.onNote = setVoiceNote;
    } else speaker.current.configure(voiceOf(settings), settings.remoteHost);
  }
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
        <SettingsScreen s={settings} update={update} speaker={speaker.current!} />
      ) : settings.mode === "remote" ? (
        <RemoteScreen s={settings} speaker={speaker.current!} update={update} />
      ) : (
        <StandaloneScreen s={settings} speaker={speaker.current!} />
      )}
      {!!voiceNote && (
        <Pressable onPress={() => setVoiceNote("")}>
          <Text style={[st.hint, { paddingHorizontal: 12 }]}>🔈 {voiceNote} (tap to dismiss)</Text>
        </Pressable>
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

function StandaloneScreen({ s, speaker }: { s: Settings; speaker: Speaker }) {
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
    speaker.stop();
    const sentences = new SentenceFeed((line) => speaker.say(line));
    setDraft("");
    handle.current = chatStream({
      baseUrl: s.baseUrl,
      apiKey,
      model: s.model,
      messages,
      onToken: (t) => {
        acc += t;
        const clean = stripThink(acc);
        setDraft(clean);
        if (s.tts) sentences.update(clean);
      },
      onDone: (e) => {
        handle.current = null;
        setDraft(null);
        const reply = stripThink(acc).trim();
        if (s.tts && !e) sentences.flush(stripThink(acc));
        if (e && !reply) {
          setErr(e);
          return;
        }
        if (!reply) return;
        const done = [...next, { role: "assistant" as const, content: reply, ts: Date.now() }];
        setHistory(done);
        saveHistory(done);
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
            speaker.stop();
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

function RemoteScreen({ s, speaker, update }: { s: Settings; speaker: Speaker; update: (p: Partial<Settings>) => void }) {
  const speakRef = useRef(s.remoteSpeak);
  speakRef.current = s.remoteSpeak;
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
          // Play runtime speech on the phone (only fresh events, not replayed history).
          if (
            ev.type === "tts" &&
            speakRef.current &&
            typeof ev.text === "string" &&
            (typeof ev.ts !== "number" || Math.abs(Date.now() - ev.ts) < 20_000)
          )
            speaker.say(ev.text);
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
        <Text style={st.hint}>🔈 on phone</Text>
        <Switch
          value={s.remoteSpeak}
          onValueChange={(v) => {
            if (!v) speaker.stop();
            update({ remoteSpeak: v });
          }}
          thumbColor={s.remoteSpeak ? C.teal : C.dim}
        />
      </View>
      <Composer onSend={send} busy={busy} placeholder="Message Circe on the PC…" />
    </KeyboardAvoidingView>
  );
}

/* ---------------- Settings ---------------- */

function SettingsScreen({ s, update, speaker }: { s: Settings; update: (p: Partial<Settings>) => void; speaker: Speaker }) {
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
      <Field key={s.model} label="Model" value={s.model} onChange={(v) => update({ model: v.trim() })} />
      {!!MODEL_CHIPS[s.preset] && (
        <View style={[st.row, { flexWrap: "wrap" }]}>
          {MODEL_CHIPS[s.preset].map((m) => (
            <Seg key={m} label={m.replace(/:free$/, "").split("/").pop() + " (free)"} on={s.model === m} onPress={() => update({ model: m })} />
          ))}
        </View>
      )}
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
      <VoiceSettings s={s} update={update} speaker={speaker} />

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
      <Text style={[st.hint, { marginTop: 24 }]}>Circe-Core mobile v0.2.0</Text>
    </ScrollView>
  );
}

const TEST_LINE = "Hi Anu, it's Circe. Does this voice suit me?";

function VoiceSettings({ s, update, speaker }: { s: Settings; update: (p: Partial<Settings>) => void; speaker: Speaker }) {
  const [voices, setVoices] = useState<PhoneVoice[]>([]);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  useEffect(() => {
    listVoices().then(setVoices);
  }, []);
  const shown = voices.filter((v) => all || /^en/i.test(v.language));
  const cur = voices.find((v) => v.identifier === s.voiceId);
  const test = () => {
    speaker.stop();
    speaker.say(TEST_LINE);
  };
  return (
    <View>
      <Text style={st.h2}>Voice</Text>
      <View style={[st.row, { justifyContent: "space-between" }]}>
        <Text style={[st.label, { flex: 1 }]}>
          Phone voice: <Text style={{ color: C.purple }}>{cur ? `${cur.name || cur.identifier} (${cur.language}${String(cur.quality) === "Enhanced" ? ", HQ" : ""})` : "system default"}</Text>
        </Text>
        <Pressable style={st.btnSmall} onPress={() => setOpen(!open)}>
          <Text style={st.btnText}>{open ? "Done" : "Choose"}</Text>
        </Pressable>
      </View>
      {open && (
        <View style={st.card}>
          <View style={[st.row, { justifyContent: "space-between" }]}>
            <Text style={st.hint}>{shown.length} voices · HQ/network first</Text>
            <Pressable onPress={() => setAll(!all)}>
              <Text style={st.link}>{all ? "English only" : "show all languages"}</Text>
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: 260 }} nestedScrollEnabled>
            {shown.map((v) => (
              <Pressable
                key={v.identifier}
                onPress={() => {
                  update({ voiceId: v.identifier });
                  speaker.stop();
                  speaker.configure({ voiceId: v.identifier, pitch: s.pitch, rate: s.rate, pcVoice: false, pcVoiceName: "" }, s.remoteHost);
                  speaker.speakPhone("Hello, I'm Circe.");
                }}
              >
                <Text style={[st.feed, v.identifier === s.voiceId && { color: C.teal }]}>
                  {v.identifier === s.voiceId ? "● " : "○ "}
                  {v.identifier} · {v.language}
                  {String(v.quality) === "Enhanced" ? " · HQ" : ""}
                  {/network/i.test(v.identifier) ? " · network" : ""}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          <Text style={st.hint}>“network” voices sound best but need internet. Missing voices? Android Settings → Text-to-speech → Google → Install voice data.</Text>
        </View>
      )}
      <Text style={st.label}>Pitch {s.pitch.toFixed(2)}</Text>
      <Slider minimumValue={0.5} maximumValue={2} step={0.05} value={s.pitch} onSlidingComplete={(v) => update({ pitch: Math.round(v * 100) / 100 })} minimumTrackTintColor={C.teal} thumbTintColor={C.teal} />
      <Text style={st.label}>Speed {s.rate.toFixed(2)}</Text>
      <Slider minimumValue={0.5} maximumValue={2} step={0.05} value={s.rate} onSlidingComplete={(v) => update({ rate: Math.round(v * 100) / 100 })} minimumTrackTintColor={C.teal} thumbTintColor={C.teal} />
      <View style={[st.row, { justifyContent: "space-between", marginVertical: 8 }]}>
        <Text style={[st.label, { flex: 1 }]}>PC neural voice (uses PC host:port above, POST/GET /tts)</Text>
        <Switch value={s.pcVoice} onValueChange={(v) => update({ pcVoice: v })} thumbColor={s.pcVoice ? C.teal : C.dim} />
      </View>
      {s.pcVoice && (
        <Field label="PC voice override (blank = runtime default, e.g. en-US-AriaNeural)" value={s.pcVoiceName} onChange={(v) => update({ pcVoiceName: v.trim() })} />
      )}
      <Pressable style={[st.btn, { alignSelf: "flex-start", marginVertical: 6 }]} onPress={test}>
        <Text style={st.btnText}>▶ Test voice</Text>
      </Pressable>
      <Text style={st.hint}>Falls back to the phone voice if the PC can't be reached.</Text>
    </View>
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
