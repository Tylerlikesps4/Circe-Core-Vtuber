import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamingSpeech } from "../streamspeak.js";
import type { AnimationCue } from "../expression.js";
import type { TtsResult } from "../tts.js";

function tts(text: string): TtsResult {
  return { ok: true, backend: "none", text };
}

/** Let the async speak chain progress before asserting mid-stream state. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("flushes sentences on boundaries and strips markers", async () => {
  const spoken: string[] = [];
  const cues: string[] = [];
  const speaker = new StreamingSpeech({
    speak: async (text) => {
      spoken.push(text);
      return tts(text);
    },
    onCue: (cue) => cues.push(cue.marker),
  });

  speaker.feed("*giggles* Hello, Master. ");
  speaker.feed("This is the second");
  await tick();
  assert.deepEqual(spoken, ["Hello, Master."], "first sentence flushed mid-stream");

  speaker.feed(" sentence!");
  await tick();
  assert.deepEqual(spoken, ["Hello, Master.", "This is the second sentence!"]);
  assert.deepEqual(cues, ["giggles"]);

  await speaker.flush();
  assert.equal(speaker.speechText(), "Hello, Master. This is the second sentence!");
  assert.equal(speaker.sentenceCount(), 2);
});

test("fires cues the instant a marker closes, even inside a sentence", async () => {
  const cueTimes: { marker: string; spokenCount: number }[] = [];
  let spokenCount = 0;
  const speaker = new StreamingSpeech({
    speak: async (text) => {
      spokenCount += 1;
      return tts(text);
    },
    onCue: (cue: AnimationCue) => cueTimes.push({ marker: cue.marker, spokenCount }),
  });

  speaker.feed("Careful now");
  assert.deepEqual(cueTimes, []);
  speaker.feed(", *pouts* or I'll");
  assert.deepEqual(cueTimes, [{ marker: "pouts", spokenCount: 0 }]);

  await speaker.flush();
  assert.equal(speaker.speechText(), "Careful now, or I'll");
  assert.equal(speaker.cues().length, 1);
  assert.equal(speaker.cues()[0].expression, "pout");
});

test("force-flushes long unpunctuated text at a word boundary", async () => {
  const spoken: string[] = [];
  const speaker = new StreamingSpeech({
    maxChars: 24,
    speak: async (text) => {
      spoken.push(text);
      return tts(text);
    },
  });
  const words = "one two three four five six seven";
  speaker.feed(words);
  await tick();
  assert.equal(spoken.length, 1, "cap exceeded triggers a flush without punctuation");
  assert.match(spoken[0], /^one two three/);
  await speaker.flush();
  assert.equal(speaker.sentenceCount(), 2);
  assert.equal(speaker.speechText(), words);
});

test("treats ~ before whitespace as a sentence end and handles unclosed markers", async () => {
  const spoken: string[] = [];
  const speaker = new StreamingSpeech({
    speak: async (text) => {
      spoken.push(text);
      return tts(text);
    },
  });
  speaker.feed("Another drop of moonlight for you, dear~ ");
  await tick();
  assert.deepEqual(spoken, ["Another drop of moonlight for you, dear~"]);
  speaker.feed("and one for the chat.");
  speaker.feed("*unfinished");
  await speaker.flush();
  assert.deepEqual(spoken, [
    "Another drop of moonlight for you, dear~",
    "and one for the chat.",
    "*unfinished",
  ]);
});

test("speaks sentences sequentially and flush() waits for the chain", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const speaker = new StreamingSpeech({
    speak: async (text) => {
      order.push("start:" + text);
      if (text === "First.") await gate;
      order.push("end:" + text);
      return tts(text);
    },
  });

  speaker.feed("First. Second.");
  await Promise.resolve(); // let the first sentence's speak() begin
  assert.deepEqual(order, ["start:First."]);

  let flushed = false;
  void speaker.flush().then(() => {
    flushed = true;
  });
  await Promise.resolve();
  assert.equal(flushed, false, "flush must wait for in-flight speech");

  release();
  await speaker.flush();
  assert.deepEqual(order, ["start:First.", "end:First.", "start:Second.", "end:Second."]);
  assert.equal(speaker.tts()?.text, "Second.");
});

test("empty feeds and empty flushes produce no speech", async () => {
  const speaker = new StreamingSpeech({ speak: async (t) => tts(t) });
  speaker.feed("");
  await speaker.flush();
  assert.equal(speaker.sentenceCount(), 0);
  assert.equal(speaker.speechText(), "");
  assert.equal(speaker.tts(), null);
});
