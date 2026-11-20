import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../bus.js";
import { StreamContextFeed } from "../stream.js";
import { ManaPool } from "../manametry.js";
import { EpisodicMemory } from "../memory.js";
import { VisionSampler } from "../vision.js";
import { GoalTracker } from "../goals.js";
import { ViewerRegistry } from "../viewers.js";

test("stores chat and game context", () => {
  const feed = new StreamContextFeed(new EventBus());
  feed.pushChat("alice", "hello circe");
  feed.setGame({ game: "elden-ring", boss: "Malenia" });

  const ctx = feed.context();
  assert.equal(ctx.chat.length, 1);
  assert.equal(ctx.chat[0].user, "alice");
  assert.equal(ctx.chat[0].message, "hello circe");
  assert.equal(ctx.game?.game, "elden-ring");
  assert.equal(ctx.game?.boss, "Malenia");
});

test("caps chat history at maxChat", () => {
  const feed = new StreamContextFeed(new EventBus(), { maxChat: 3 });
  for (let i = 0; i < 5; i++) feed.pushChat("u", `m${i}`);
  const chat = feed.context().chat;
  assert.equal(chat.length, 3);
  assert.equal(chat[0].message, "m2");
  assert.equal(chat[2].message, "m4");
});

test("event bus replays events since a sequence", () => {
  const bus = new EventBus();
  bus.emit("chat", { user: "a", message: "one" });
  const second = bus.emit("chat", { user: "b", message: "two" });
  bus.emit("chat", { user: "c", message: "three" });

  const replay = bus.since(second.seq);
  assert.equal(replay.length, 1);
  assert.equal(replay[0].user, "c");
});

test("persists events to the log file, creating its directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-"));
  try {
    const bus = new EventBus({ logFile: join(dir, "logs", "events.jsonl") });
    bus.emit("chat", { user: "a", message: "hi" });

    const lines = readFileSync(join(dir, "logs", "events.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]) as { type: string; user: string };
    assert.equal(event.type, "chat");
    assert.equal(event.user, "a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("http endpoints serve chat and context", async () => {
  const feed = new StreamContextFeed(new EventBus(), { port: 0 });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;

    const health = (await (await fetch(`${base}/health`)).json()) as { ok: boolean };
    assert.equal(health.ok, true);

    const posted = (await (
      await fetch(`${base}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: "alice", message: "hello circe" }),
      })
    ).json()) as { ok: boolean };
    assert.equal(posted.ok, true);

    const ctx = (await (await fetch(`${base}/context`)).json()) as {
      chat: { user: string; message: string }[];
    };
    assert.equal(ctx.chat.length, 1);
    assert.equal(ctx.chat[0].message, "hello circe");
  } finally {
    await feed.stop();
  }
});

test("POST /metrics feeds the mana pool and GET /mana reads it", async () => {
  const mana = new ManaPool({ gpu: false });
  const feed = new StreamContextFeed(new EventBus(), { port: 0, mana });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;
    const posted = (await (
      await fetch(`${base}/metrics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contextUsed: 500, contextTotal: 6600 }),
      })
    ).json()) as { ok: boolean };
    assert.equal(posted.ok, true);

    const snapshot = (await (await fetch(`${base}/mana`)).json()) as {
      gpu: unknown;
      context: { used: number; total: number };
    };
    assert.equal(snapshot.gpu, null);
    assert.equal(snapshot.context.used, 500);
    assert.equal(snapshot.context.total, 6600);
  } finally {
    await feed.stop();
  }
});

test("GET / lists endpoints and POST /reply runs the pipeline", async () => {
  const replies: string[] = [];
  const feed = new StreamContextFeed(new EventBus(), {
    port: 0,
    onReply: async (text) => {
      replies.push(text);
      return { speech: text, cues: [], tts: { ok: true } };
    },
  });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;

    const index = (await (await fetch(`${base}/`)).json()) as { endpoints: string[] };
    assert.ok(index.endpoints.includes("POST /reply"));

    const posted = (await (
      await fetch(`${base}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "*giggles* Hello, piglets!" }),
      })
    ).json()) as { ok: boolean; reply: { speech: string } };
    assert.equal(posted.ok, true);
    assert.equal(posted.reply.speech, "*giggles* Hello, piglets!");
    assert.deepEqual(replies, ["*giggles* Hello, piglets!"]);

    const empty = await fetch(`${base}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "  " }),
    });
    assert.equal(empty.status, 400);

    const noPipeline = await fetch(`${base}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(noPipeline.status, 200);
  } finally {
    await feed.stop();
  }
});

test("GET / serves the dashboard to browsers and JSON otherwise", async () => {
  const feed = new StreamContextFeed(new EventBus(), { port: 0 });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;

    const html = await fetch(`${base}/`, { headers: { accept: "text/html" } });
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);
    const body = await html.text();
    assert.match(body, /<!doctype html>/i);
    assert.match(body, /Circe-Core/);
    assert.match(body, /id="reply-form"/);

    const json = await fetch(`${base}/`, { headers: { accept: "application/json" } });
    const data = (await json.json()) as { ok: boolean; endpoints: string[] };
    assert.equal(data.ok, true);
    assert.ok(data.endpoints.includes("POST /reply"));

    const forcedJson = await fetch(`${base}/?format=json`, { headers: { accept: "text/html" } });
    assert.match(forcedJson.headers.get("content-type") ?? "", /application\/json/);
  } finally {
    await feed.stop();
  }
});

test("POST /ask requires the brain pipeline and passes messages", async () => {
  const seen: { message: string; reflect?: boolean; tools?: boolean; stream?: boolean }[] = [];
  const feed = new StreamContextFeed(new EventBus(), {
    port: 0,
    onAsk: async (message, opts) => {
      seen.push({ message, ...opts });
      return { answer: "*smugs* Soon, Master.", processed: { speech: "Soon, Master." } };
    },
  });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;
    const posted = (await (
      await fetch(`${base}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "what is brewing?" }),
      })
    ).json()) as { ok: boolean; answer: string; processed: { speech: string } };
    assert.equal(posted.ok, true);
    assert.equal(posted.answer, "*smugs* Soon, Master.");
    assert.deepEqual(seen, [
      { message: "what is brewing?", reflect: false, tools: false, stream: false },
    ]);

    await fetch(`${base}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "think twice", reflect: true, tools: true }),
    });
    assert.deepEqual(seen[1], { message: "think twice", reflect: true, tools: true, stream: false });

    await fetch(`${base}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "speak fast", stream: true }),
    });
    assert.deepEqual(seen[2], { message: "speak fast", reflect: false, tools: false, stream: true });

    const empty = await fetch(`${base}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    assert.equal(empty.status, 400);
  } finally {
    await feed.stop();
  }

  const bare = new StreamContextFeed(new EventBus(), { port: 0 });
  await bare.start();
  try {
    const res = await fetch(`http://127.0.0.1:${bare.port}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello?" }),
    });
    assert.equal(res.status, 404);
  } finally {
    await bare.stop();
  }
});

test("GET /goals reports tracker status and POST /goals/advance advances the step", async () => {
  const goals = new GoalTracker([
    {
      id: "g1",
      description: "first goal",
      steps: ["Step 1", "Step 2"],
      check: (c) => c.chat.length >= 1,
    },
    { id: "g2", description: "second goal", check: () => false },
  ]);
  goals.evaluate({ chat: [], now: Date.now() });
  const feed = new StreamContextFeed(new EventBus(), { port: 0, goals });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;
    const status = (await (await fetch(`${base}/goals`)).json()) as {
      ok: boolean;
      active: { id: string; description: string; steps: { description: string }[]; stepIndex: number } | null;
      pending: { id: string; description: string }[];
      done: number;
    };
    assert.equal(status.ok, true);
    assert.equal(status.active?.id, "g1");
    assert.equal(status.active?.steps.length, 2);
    assert.equal(status.active?.stepIndex, 0);
    assert.deepEqual(status.pending.map((g) => g.id), ["g2"]);
    assert.equal(status.done, 0);

    const advRes = (await (
      await fetch(`${base}/goals/advance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "test advance" }),
      })
    ).json()) as {
      ok: boolean;
      active: { stepIndex: number };
    };
    assert.equal(advRes.ok, true);
    assert.equal(advRes.active?.stepIndex, 1);

    const bare = new StreamContextFeed(new EventBus(), { port: 0 });
    await bare.start();
    try {
      const res = await fetch(`http://127.0.0.1:${bare.port}/goals`);
      assert.equal(res.status, 404);
      const resPost = await fetch(`http://127.0.0.1:${bare.port}/goals/advance`, { method: "POST" });
      assert.equal(resPost.status, 404);
    } finally {
      await bare.stop();
    }
  } finally {
    await feed.stop();
  }
});

test("GET /vision serves the latest frame or 404s without one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-vision-http-"));
  const sampler = new VisionSampler({
    outDir: dir,
    runImpl: async (_cmd, args) => {
      writeFileSync(String(args[args.length - 1]), "jpeg-bytes");
      return { ok: true };
    },
  });
  const feed = new StreamContextFeed(new EventBus(), { port: 0, vision: sampler });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;
    const missing = await fetch(`${base}/vision`);
    assert.equal(missing.status, 404);

    await sampler.capture();
    const img = await fetch(`${base}/vision`);
    assert.equal(img.status, 200);
    assert.match(img.headers.get("content-type") ?? "", /image\/jpeg/);
    assert.equal(await img.text(), "jpeg-bytes");

    const meta = (await (await fetch(`${base}/vision?format=json`)).json()) as {
      ok: boolean;
      ts: number;
      file: string;
    };
    assert.equal(meta.ok, true);
    assert.ok(typeof meta.ts === "number");
    assert.ok(meta.file.endsWith(".jpg"));

    const bare = await fetch(`http://127.0.0.1:${feed.port}/vision`);
    assert.equal(bare.status, 200, "frame stays available");
  } finally {
    await feed.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /remember stores facts and GET /memory recalls them", async () => {
  const memory = new EpisodicMemory();
  const bus = new EventBus();
  const events: string[] = [];
  bus.on((event) => {
    if (event.type === "memory") events.push(String(event.text));
  });
  const feed = new StreamContextFeed(bus, { port: 0, memory });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;
    const posted = (await (
      await fetch(`${base}/remember`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Alice loves succulents", tags: ["viewer:alice"] }),
      })
    ).json()) as { ok: boolean; fact: { id: number; tags: string[] } };
    assert.equal(posted.ok, true);
    assert.deepEqual(posted.fact.tags, ["viewer:alice"]);
    assert.deepEqual(events, ["Alice loves succulents"]);

    const listed = (await (await fetch(`${base}/memory`)).json()) as {
      facts: { text: string }[];
    };
    assert.equal(listed.facts.length, 1);

    const recalled = (await (
      await fetch(`${base}/memory?q=succulents&limit=3`)
    ).json()) as { facts: { text: string }[] };
    assert.equal(recalled.facts[0].text, "Alice loves succulents");

    await fetch(`${base}/remember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "She keeps them on the windowsill", tags: ["viewer:alice", "lore"] }),
    });

    const graph = (await (await fetch(`${base}/memory?q=succulents&graph=1`)).json()) as {
      results: { fact: { text: string }; via: string[] }[];
    };
    assert.equal(graph.results.length, 2);
    assert.ok(graph.results[1].via.includes("viewer:alice"));

    const related = (await (await fetch(`${base}/memory?tag=viewer:alice&limit=5`)).json()) as {
      related: { tag: string; weight: number }[];
    };
    assert.deepEqual(related.related, [{ tag: "lore", weight: 1 }]);

    const empty = await fetch(`${base}/remember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "  " }),
    });
    assert.equal(empty.status, 400);
  } finally {
    await feed.stop();
  }

  const bare = new StreamContextFeed(new EventBus(), { port: 0 });
  await bare.start();
  try {
    const res = await fetch(`http://127.0.0.1:${bare.port}/memory`);
    assert.equal(res.status, 404);
  } finally {
    await bare.stop();
  }
});

test("GET /params reflects vtube-param and vtube-face bus events", async () => {  const bus = new EventBus();
  const feed = new StreamContextFeed(bus, { port: 0 });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;
    bus.emit("vtube-param", { name: "MouthOpen", value: 0.7 });
    bus.emit("vtube-face", { found: true, mouthOpen: 0.2 });

    const live = (await (await fetch(`${base}/params`)).json()) as {
      params: Record<string, number>;
      face: { found: boolean; mouthOpen: number } | null;
    };
    assert.equal(live.params.MouthOpen, 0.7);
    assert.equal(live.face?.found, true);
    assert.equal(live.face?.mouthOpen, 0.2);
  } finally {
    await feed.stop();
  }
});

test("/metrics rejects malformed bodies and feeds without mana", async () => {  const feed = new StreamContextFeed(new EventBus(), { port: 0 });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;
    const noMana = await fetch(`${base}/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contextUsed: 1, contextTotal: 2 }),
    });
    assert.equal(noMana.status, 404);

    const mana = new ManaPool({ gpu: false });
    const withMana = new StreamContextFeed(new EventBus(), { port: 0, mana });
    await withMana.start();
    try {
      const bad = await fetch(`http://127.0.0.1:${withMana.port}/metrics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contextUsed: "lots" }),
      });
      assert.equal(bad.status, 400);
    } finally {
      await withMana.stop();
    }
  } finally {
    await feed.stop();
  }
});

test("POST /recap runs the recap pipeline", async () => {
  let calls = 0;
  const feed = new StreamContextFeed(new EventBus(), {
    port: 0,
    onRecap: async () => {
      calls += 1;
      return { facts: ["Session was lively."], summary: "Session was lively.", source: "fallback" };
    },
  });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;
    const posted = (await (await fetch(`${base}/recap`, { method: "POST" })).json()) as {
      ok: boolean;
      recap: { facts: string[]; source: string };
    };
    assert.equal(posted.ok, true);
    assert.deepEqual(posted.recap.facts, ["Session was lively."]);
    assert.equal(posted.recap.source, "fallback");
    assert.equal(calls, 1);
  } finally {
    await feed.stop();
  }

  const bare = new StreamContextFeed(new EventBus(), { port: 0 });
  await bare.start();
  try {
    const res = await fetch(`http://127.0.0.1:${bare.port}/recap`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    await bare.stop();
  }
});

test("GET /viewers and POST /viewers/:user manage chatter relationship profiles", async () => {
  const bus = new EventBus();
  const viewers = new ViewerRegistry();
  viewers.recordMessage("alice", "hi");
  viewers.adjustAffinity("alice", 20);

  const feed = new StreamContextFeed(bus, { port: 0, viewers });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;

    // List viewers
    const listRes = (await (await fetch(`${base}/viewers`)).json()) as {
      ok: boolean;
      viewers: { user: string; affinity: number; tier: string }[];
    };
    assert.equal(listRes.ok, true);
    assert.equal(listRes.viewers.length, 1);
    assert.equal(listRes.viewers[0].user, "alice");
    assert.equal(listRes.viewers[0].affinity, 20);

    // Get single viewer
    const getRes = (await (await fetch(`${base}/viewers/alice`)).json()) as {
      ok: boolean;
      viewer: { user: string; tier: string };
    };
    assert.equal(getRes.ok, true);
    assert.equal(getRes.viewer.user, "alice");

    // 404 on missing viewer
    const missingRes = await fetch(`${base}/viewers/nobody`);
    assert.equal(missingRes.status, 404);

    // Update viewer via POST /viewers/:user
    let busEvent: unknown = null;
    bus.on((e) => {
      if (e.type === "viewer-update") busEvent = e;
    });

    const postRes = (await (
      await fetch(`${base}/viewers/alice`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          delta: 15,
          tier: "vip",
          note: "alchemist friend",
          personaId: "evil-neuro",
        }),
      })
    ).json()) as {
      ok: boolean;
      viewer: { user: string; tier: string; affinity: number; notes: string[]; personaId?: string };
    };
    assert.equal(postRes.ok, true);
    assert.equal(postRes.viewer.tier, "vip");
    assert.equal(postRes.viewer.affinity, 35);
    assert.deepEqual(postRes.viewer.notes, ["alchemist friend"]);
    assert.equal(postRes.viewer.personaId, "evil-neuro");
    assert.ok(busEvent);

    // 404 without viewers configured
    const bare = new StreamContextFeed(new EventBus(), { port: 0 });
    await bare.start();
    try {
      const bareGet = await fetch(`http://127.0.0.1:${bare.port}/viewers`);
      assert.equal(bareGet.status, 404);
      const barePost = await fetch(`http://127.0.0.1:${bare.port}/viewers/alice`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delta: 5 }),
      });
      assert.equal(barePost.status, 404);
    } finally {
      await bare.stop();
    }
  } finally {
    await feed.stop();
  }
});



test("POST /cue emits an expression cue on the bus", async () => {
  const bus = new EventBus();
  const feed = new StreamContextFeed(bus, { port: 0 });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;
    const ok = await fetch(`${base}/cue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marker: "*giggles*" }),
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { ok: boolean; cue: { expression: string } };
    assert.equal(body.cue.expression, "joy");
    const events = bus.since(0).filter((e) => e.type === "expression");
    assert.equal(events.length, 1);
    assert.equal(events[0].marker, "giggles");
    const bad = await fetch(`${base}/cue`, { method: "POST", body: "{}" });
    assert.equal(bad.status, 400);
  } finally {
    await feed.stop();
  }
});

test("POST /tts returns audio bytes and rejects bad input", async () => {
  const calls: Array<{ text: string; voice?: string }> = [];
  const feed = new StreamContextFeed(new EventBus(), {
    port: 0,
    maxTtsChars: 20,
    onTts: async (text, voice) => {
      calls.push({ text, voice });
      return { audio: Buffer.from("RIFFfake"), contentType: "audio/wav" };
    },
  });
  await feed.start();
  try {
    const base = `http://127.0.0.1:${feed.port}`;
    const ok = await fetch(`${base}/tts`, {
      method: "POST",
      body: JSON.stringify({ text: " Hello there. ", voice: "en-US-AriaNeural" }),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "audio/wav");
    assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), "RIFFfake");
    assert.deepEqual(calls[0], { text: "Hello there.", voice: "en-US-AriaNeural" });

    for (const body of ["{bad", JSON.stringify({}), JSON.stringify({ text: "   " }), JSON.stringify({ text: "x".repeat(21) })]) {
      const r = await fetch(`${base}/tts`, { method: "POST", body });
      assert.equal(r.status, 400, body);
      await r.text();
    }
    assert.equal(calls.length, 1);

    const get = await fetch(`${base}/tts?text=${encodeURIComponent("Hi you")}&voice=bad%20voice!`);
    assert.equal(get.status, 200);
    await get.arrayBuffer();
    assert.deepEqual(calls[1], { text: "Hi you", voice: undefined });
    const getBad = await fetch(`${base}/tts`);
    assert.equal(getBad.status, 400);
    await getBad.text();
  } finally {
    await feed.stop();
  }
});

test("POST /tts is 503 without a gateway and passes synth errors through", async () => {
  const off = new StreamContextFeed(new EventBus(), { port: 0 });
  await off.start();
  try {
    const r = await fetch(`http://127.0.0.1:${off.port}/tts`, { method: "POST", body: '{"text":"hi"}' });
    assert.equal(r.status, 503);
    await r.text();
  } finally {
    await off.stop();
  }
  const bad = new StreamContextFeed(new EventBus(), {
    port: 0,
    onTts: async () => ({ error: "no backend", status: 501 }),
  });
  await bad.start();
  try {
    const r = await fetch(`http://127.0.0.1:${bad.port}/tts`, { method: "POST", body: '{"text":"hi"}' });
    assert.equal(r.status, 501);
    assert.equal(((await r.json()) as { error: string }).error, "no backend");
  } finally {
    await bad.stop();
  }
});
