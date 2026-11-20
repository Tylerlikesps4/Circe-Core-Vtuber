import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWav, detectSpeech, parseWav, rms } from "../vad.js";

test("buildWav and parseWav round-trip 16-bit mono PCM", () => {
  const samples = [100, -100, 1000, -1000, 0, 0];
  const wav = buildWav(samples, 8000);
  const parsed = parseWav(wav);
  assert.ok(parsed);
  assert.equal(parsed.sampleRate, 8000);
  assert.deepEqual([...parsed.samples], samples);
});

test("parseWav rejects garbage and empty containers", () => {
  assert.equal(parseWav(new Uint8Array([1, 2, 3, 4, 5])), null);
  assert.equal(parseWav(Buffer.from("RIFF0000WAVE")), null);
});

test("rms computes window energy on the 0..1 scale", () => {
  const samples = new Int16Array([32768, 0, 0, 0]);
  assert.equal(rms(samples, 0, 4), 0.5);
  assert.equal(rms(samples, 4, 8), 0, "windows past the end carry no energy");
});

test("detectSpeech finds a loud tone and ignores silence", () => {
  const rate = 16000;
  const tone = buildWav(
    Array.from({ length: rate }, (_, i) => Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / rate))),
    rate,
  );
  const loud = detectSpeech(tone);
  assert.equal(loud.speech, true);
  assert.ok(loud.peak > 0.1);

  const silence = detectSpeech(buildWav(new Int16Array(rate), rate));
  assert.equal(silence.speech, false);
  assert.equal(silence.peak, 0);
});

test("detectSpeech threshold gates soft audio", () => {
  const rate = 16000;
  const soft = buildWav(
    Array.from({ length: rate }, (_, i) => Math.round(50 * Math.sin((2 * Math.PI * 440 * i) / rate))),
    rate,
  );
  assert.equal(detectSpeech(soft, { threshold: 0.01 }).speech, false);
  assert.equal(detectSpeech(soft, { threshold: 0.001 }).speech, true);
});

test("detectSpeech returns false for malformed audio", () => {
  const result = detectSpeech(Buffer.from("not a wav at all"));
  assert.deepEqual(result, { speech: false, peak: 0 });
});
