import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../bus.js";
import { BlueskyChat, BlueskySocket, parseJetstream, postMatches } from "../bluesky.js";

class FakeSocket implements BlueskySocket {
  sent: string[] = [];
  private handlers = new Map<string, ((event: unknown) => void)[]>();

  constructor(public url: string) {
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  close(): void {
    queueMicrotask(() => this.emit("close", {}));
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }

  data(payload: string): void {
    this.emit("message", { data: payload });
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function commit(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    did: "did:plc:author1",
    time_us: 1718558073658683,
    kind: "commit",
    commit: {
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "3kabc",
      record: { text: "hello circe" },
    },
    identity: { handle: "piglet.bsky.social" },
    ...overrides,
  });
}

const WATCHED_DID = "did:plc:streamer";

test("parseJetstream keeps only new posts", () => {
  assert.ok(parseJetstream(commit({})));
  assert.equal(parseJetstream(commit({ kind: "identity" })), null);
  assert.equal(parseJetstream(commit({ commit: { operation: "delete", collection: "app.bsky.feed.post" } })), null);
  assert.equal(parseJetstream(commit({ commit: { operation: "create", collection: "app.bsky.feed.like" } })), null);
  assert.equal(parseJetstream("not json"), null);
});

test("postMatches detects replies, facet mentions, and @handle fallback", () => {
  const dids = new Set([WATCHED_DID]);
  const handles = new Set(["streamer"]);

  const reply = parseJetstream(
    commit({
      commit: {
        operation: "create",
        collection: "app.bsky.feed.post",
        rkey: "x",
        record: { text: "great stream", reply: { parent: { uri: `at://${WATCHED_DID}/app.bsky.feed.post/abc` } } },
      },
    }),
  );
  assert.equal(postMatches(reply!, dids, handles), true);

  const mention = parseJetstream(
    commit({
      commit: {
        operation: "create",
        collection: "app.bsky.feed.post",
        rkey: "x",
        record: {
          text: "look at this",
          facets: [{ features: [{ $type: "app.bsky.richtext.facet#mention", did: WATCHED_DID }] }],
        },
      },
    }),
  );
  assert.equal(postMatches(mention!, dids, handles), true);

  const textOnly = parseJetstream(
    commit({
      commit: {
        operation: "create",
        collection: "app.bsky.feed.post",
        rkey: "x",
        record: { text: "hey @Streamer what's up" },
      },
    }),
  );
  assert.equal(postMatches(textOnly!, new Set(), handles), true, "@handle text matches without DIDs");

  const unrelated = parseJetstream(commit({}));
  assert.equal(postMatches(unrelated!, dids, handles), false);
});

test("emits bluesky-message for posts touching the watched handles", async () => {
  const bus = new EventBus();
  const messages: { user: string; message: string }[] = [];
  bus.on((event) => {
    if (event.type === "bluesky-message") {
      messages.push({ user: String(event.user), message: String(event.message) });
    }
  });
  const fake = new FakeSocket("wss://jetstream/");
  const chat = new BlueskyChat(bus, {
    handles: ["streamer.bsky.social"],
    wsFactory: () => fake,
    fetchImpl: async () =>
      new Response(JSON.stringify({ did: WATCHED_DID }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  chat.start();
  await tick();
  await tick();

  fake.data(
    commit({
      commit: {
        operation: "create",
        collection: "app.bsky.feed.post",
        rkey: "r1",
        record: { text: "the brew is real", reply: { parent: { uri: `at://${WATCHED_DID}/app.bsky.feed.post/p1` } } },
      },
    }),
  );
  await tick();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].user, "piglet.bsky.social");
  assert.equal(messages[0].message, "the brew is real");

  // Unrelated posts and self posts stay out.
  fake.data(commit({}));
  fake.data(
    commit({
      did: WATCHED_DID,
      identity: { handle: "streamer.bsky.social" },
      commit: {
        operation: "create",
        collection: "app.bsky.feed.post",
        rkey: "r2",
        record: { text: "my own post" },
      },
    }),
  );
  await tick();
  assert.equal(messages.length, 1);

  chat.stop();
  assert.deepEqual(chat.resolvedDids, [WATCHED_DID]);
});

test("reconnects with backoff after the socket closes", async () => {
  const bus = new EventBus();
  const errors: string[] = [];
  bus.on((event) => {
    if (event.type === "bluesky-error") errors.push(String(event.message));
  });
  const sockets: FakeSocket[] = [];
  const chat = new BlueskyChat(bus, {
    handles: ["streamer.bsky.social"],
    reconnectBaseMs: 10,
    reconnectMaxMs: 40,
    wsFactory: (url) => {
      const fake = new FakeSocket(url);
      sockets.push(fake);
      return fake;
    },
    fetchImpl: async () =>
      new Response(JSON.stringify({ did: WATCHED_DID }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  chat.start();
  await tick();
  await tick();
  assert.equal(sockets.length, 1);

  sockets[0].close();
  await tick();
  assert.ok(errors.some((e) => e.includes("reconnecting in")), "backoff error emitted");

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sockets.length, 2, "reconnected after backoff");
  chat.stop();
});

test("falls back to @mention matching when handle resolution fails", async () => {
  const bus = new EventBus();
  const messages: string[] = [];
  bus.on((event) => {
    if (event.type === "bluesky-message") messages.push(String(event.message));
  });
  const fake = new FakeSocket("wss://jetstream/");
  const chat = new BlueskyChat(bus, {
    handles: ["streamer.bsky.social"],
    wsFactory: () => fake,
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  chat.start();
  await tick();
  await tick();
  assert.deepEqual(chat.resolvedDids, []);

  fake.data(
    commit({
      commit: {
        operation: "create",
        collection: "app.bsky.feed.post",
        rkey: "r1",
        record: { text: "shoutout @streamer.bsky.social!" },
      },
    }),
  );
  await tick();
  assert.deepEqual(messages, ["shoutout @streamer.bsky.social!"]);
  chat.stop();
});
