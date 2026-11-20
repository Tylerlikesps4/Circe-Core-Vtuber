import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../bus.js";
import { YoutubeChat } from "../youtube.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test("polls liveChat.messages and emits youtube-message events", async () => {
  const bus = new EventBus();
  const messages: { user: string; message: string; tags: unknown }[] = [];
  bus.on((event) => {
    if (event.type === "youtube-message") {
      messages.push({
        user: String(event.user),
        message: String(event.message),
        tags: event.tags,
      });
    }
  });

  let requestedUrl = "";
  const chat = new YoutubeChat(bus, {
    apiKey: "key-123",
    liveChatId: "live-abc",
    pollIntervalMs: 10_000,
    fetchImpl: async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return jsonResponse({
        pollingIntervalMillis: 5000,
        nextPageToken: "page-2",
        items: [
          {
            snippet: { displayMessage: "first!" },
            authorDetails: { displayName: "PigletOne", isChatModerator: true },
          },
        ],
      });
    },
  });
  chat.start();
  await tick();
  chat.stop();

  assert.ok(requestedUrl.includes("https://www.googleapis.com/youtube/v3/liveChat/messages"));
  assert.ok(requestedUrl.includes("liveChatId=live-abc"));
  assert.ok(requestedUrl.includes("key=key-123"));
  assert.ok(!requestedUrl.includes("pageToken"));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].user, "PigletOne");
  assert.equal(messages[0].message, "first!");
  assert.deepEqual(messages[0].tags, { isOwner: false, isModerator: true, isMember: false });
});

test("skips empty messages and keeps polling", async () => {
  const bus = new EventBus();
  let call = 0;
  const chat = new YoutubeChat(bus, {
    apiKey: "k",
    liveChatId: "l",
    pollIntervalMs: 10,
    fetchImpl: async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({ items: [{ snippet: { displayMessage: "" } }] });
      }
      return jsonResponse({
        items: [
          {
            snippet: { displayMessage: "second wave" },
            authorDetails: { displayName: "anon" },
          },
        ],
      });
    },
  });

  const messages: string[] = [];
  bus.on((event) => {
    if (event.type === "youtube-message") messages.push(String(event.message));
  });

  chat.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  chat.stop();
  assert.ok(call >= 2, `expected multiple polls, got ${call}`);
  assert.ok(messages.length >= 1);
  assert.ok(messages.every((m) => m === "second wave"));
});

test("emits youtube-error when the API fails", async () => {
  const bus = new EventBus();
  const errors: string[] = [];
  bus.on((event) => {
    if (event.type === "youtube-error") errors.push(String(event.message));
  });
  const chat = new YoutubeChat(bus, {
    apiKey: "k",
    liveChatId: "l",
    pollIntervalMs: 10_000,
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  chat.start();
  await tick();
  chat.stop();
  assert.ok(errors.some((e) => e.includes("network down")));
});
