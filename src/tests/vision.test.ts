import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../bus.js";
import { frameCommand, VisionSampler } from "../vision.js";

test("frameCommand builds platform-specific single-frame grabs", () => {
  const win = frameCommand("win32", undefined, "out.jpg", 4, "ffmpeg");
  assert.equal(win.cmd, "ffmpeg");
  assert.deepEqual(win.args.slice(0, 5), ["-y", "-f", "dshow", "-i", "video=OBS Virtual Camera"]);
  assert.ok(win.args.includes("-frames:v"));
  assert.ok(win.args.includes("out.jpg"));

  const mac = frameCommand("darwin", "1:none", "m.jpg", 3);
  assert.deepEqual(mac.args.slice(0, 5), ["-y", "-f", "avfoundation", "-i", "1:none"]);

  const lin = frameCommand("linux", "/dev/video2", "l.jpg", 2);
  assert.deepEqual(lin.args.slice(0, 5), ["-y", "-f", "v4l2", "-i", "/dev/video2"]);
});

test("capture runs the command, records the frame, and emits an event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-vision-"));
  const events: string[] = [];
  const bus = new EventBus();
  bus.on((event) => {
    if (event.type === "vision-frame") events.push(String(event.file));
  });
  const sampler = new VisionSampler(
    {
      outDir: dir,
      runImpl: async (_cmd, args) => {
        const out = args[args.length - 1] ?? "";
        writeFileSync(out, "fakejpeg");
        return { ok: true };
      },
    },
    bus,
  );
  try {
    const frame = await sampler.capture();
    assert.equal(frame.ok, true);
    assert.equal(sampler.latest()?.file, frame.file);
    assert.deepEqual(events, [frame.file]);

    const part = sampler.framePart();
    assert.equal(part?.type, "image_url");
    assert.match(part.image_url.url, /^data:image\/jpeg;base64,/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture reports failure when the runner fails or writes no file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-vision-"));
  try {
    const failing = new VisionSampler({
      outDir: dir,
      runImpl: async () => ({ ok: false, detail: "no camera" }),
    });
    const frame = await failing.capture();
    assert.equal(frame.ok, false);
    assert.match(frame.detail ?? "", /no camera/);
    assert.equal(failing.latest(), null);
    assert.equal(failing.framePart(), null);

    const silent = new VisionSampler({
      outDir: dir,
      runImpl: async () => ({ ok: true }),
    });
    const missing = await silent.capture();
    assert.equal(missing.ok, false, "runner claiming success without a file fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prunes old frames beyond maxFrames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-vision-"));
  try {
    writeFileSync(join(dir, "frame-1700000000100.jpg"), "old");
    writeFileSync(join(dir, "frame-1700000000200.jpg"), "old2");
    const sampler = new VisionSampler({
      outDir: dir,
      maxFrames: 2,
      runImpl: async (_cmd, args) => {
        writeFileSync(args[args.length - 1] ?? "", "new");
        return { ok: true };
      },
    });
    await sampler.capture();
    const frames = readdirSync(dir).filter((name) => name.endsWith(".jpg")).sort();
    assert.equal(frames.length, 2);
    assert.equal(frames[0].startsWith("frame-1700000000200"), true, "oldest frame dropped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start polls on the interval and stop cancels", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dir = mkdtempSync(join(tmpdir(), "circe-vision-"));
  let captures = 0;
  const sampler = new VisionSampler({
    outDir: dir,
    intervalMs: 5000,
    runImpl: async (_cmd, args) => {
      captures += 1;
      writeFileSync(args[args.length - 1] ?? "", "x");
      return { ok: true };
    },
  });
  try {
    sampler.start();
    assert.equal(captures, 1, "start grabs one frame immediately");

    t.mock.timers.tick(5000);
    await Promise.resolve();
    assert.equal(captures, 2, "interval fires the next grab");

    sampler.stop();
    t.mock.timers.tick(10_000);
    await Promise.resolve();
    assert.equal(captures, 2, "stop cancels further grabs");
  } finally {
    sampler.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
