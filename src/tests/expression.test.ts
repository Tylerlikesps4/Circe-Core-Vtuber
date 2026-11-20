import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReply } from "../expression.js";

test("strips vocal markers from speech", () => {
  const { speech } = parseReply("*giggles* Oh? A donation, Master~");
  assert.equal(speech, "Oh? A donation, Master~");
});

test("classifies known vocal cues", () => {
  const { cues } = parseReply("*pouts* *smugs*");
  assert.equal(cues.length, 2);
  assert.equal(cues[0].kind, "vocal");
  assert.equal(cues[0].expression, "pout");
  assert.equal(cues[1].expression, "smug");
});

test("classifies gesture cues and infers mood", () => {
  const { cues } = parseReply("*tilts head with a mischievous smile* hi");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].kind, "gesture");
  assert.equal(cues[0].expression, "gesture");
  assert.equal(cues[0].mood, "playful");
});

test("handles replies with no markers", () => {
  const { speech, cues } = parseReply("Dear Chat, you are all lovely tonight.");
  assert.equal(speech, "Dear Chat, you are all lovely tonight.");
  assert.equal(cues.length, 0);
});

test("handles empty reply", () => {
  const { speech, cues } = parseReply("");
  assert.equal(speech, "");
  assert.equal(cues.length, 0);
});

test("collapses whitespace left by removed markers", () => {
  const { speech } = parseReply("*sighs*   tapping the side of her head");
  assert.equal(speech, "tapping the side of her head");
});
