import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTimeline, estimateSpeechMs, msPerWord, wavDurationMs } from "../lipsync.js";
import { parseReply } from "../expression.js";

test("estimateSpeechMs scales with word count and rate", () => {
  assert.equal(estimateSpeechMs("", 150), 0);
  const fast = estimateSpeechMs("one two three four", 240);
  const slow = estimateSpeechMs("one two three four", 120);
  assert.equal(fast, 1000);
  assert.equal(slow, 2000);
});

test("buildTimeline emits contiguous per-word segments", () => {
  const { segments, durationMs } = buildTimeline("one two three", 300);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].startMs, 0);
  assert.equal(segments[0].endMs, 200);
  assert.equal(segments[1].startMs, 200);
  assert.equal(segments[1].endMs, 400);
  assert.equal(segments[2].startMs, 400);
  assert.equal(durationMs, 600);
  assert.equal(msPerWord(300), 200);
});

test("parseReply stamps cues with estimated timeline positions", () => {
  const { cues } = parseReply("Hello dear chat. *giggles* Welcome to the stream, piglets.", { wpm: 150 });
  assert.equal(cues.length, 1);
  // three words before the marker at 400ms/word
  assert.equal(cues[0].atMs, 1200);
});

test("wavDurationMs reads a RIFF header", () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-wav-"));
  try {
    const file = join(dir, "sample.wav");
    const sampleRate = 16000;
    const byteRate = sampleRate * 2;
    const dataSize = byteRate * 3; // 3 seconds of mono 16-bit
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write("RIFF", 0, "ascii");
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8, "ascii");
    buffer.write("fmt ", 12, "ascii");
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(2, 32); // block align
    buffer.writeUInt16LE(16, 34); // bits
    buffer.write("data", 36, "ascii");
    buffer.writeUInt32LE(dataSize, 40);
    writeFileSync(file, buffer);

    assert.equal(wavDurationMs(file), 3000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wavDurationMs returns null for missing or invalid files", () => {
  assert.equal(wavDurationMs("media/never-here.wav"), null);
  const dir = mkdtempSync(join(tmpdir(), "circe-wav-"));
  try {
    const file = join(dir, "junk.wav");
    writeFileSync(file, "this is not a wave file");
    assert.equal(wavDurationMs(file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
