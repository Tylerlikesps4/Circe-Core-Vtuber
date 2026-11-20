import { test } from "node:test";
import assert from "node:assert/strict";
import { playAudioFile, playbackCommand } from "../playback.js";

test("win32 wraps the file in a PowerShell MediaPlayer session", () => {
  const { cmd, args } = playbackCommand("win32", "media/circe-edge.mp3");
  assert.equal(cmd, "powershell");
  assert.ok(args.includes("-NoProfile"));
  assert.ok(args.includes("-NonInteractive"));
  const script = args[args.indexOf("-Command") + 1];
  assert.ok(script.includes("media/circe-edge.mp3"));
  assert.ok(script.includes("MediaPlayer"));
});

test("darwin plays via afplay", () => {
  const { cmd, args } = playbackCommand("darwin", "media/circe-piper.wav");
  assert.equal(cmd, "afplay");
  assert.deepEqual(args, ["media/circe-piper.wav"]);
});

test("linux plays via paplay", () => {
  const { cmd, args } = playbackCommand("linux", "media/circe-piper.wav");
  assert.equal(cmd, "paplay");
  assert.deepEqual(args, ["media/circe-piper.wav"]);
});

test("missing audio file fails fast without spawning", async () => {
  const result = await playAudioFile("media/definitely-not-here.wav");
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /not found/);
});
