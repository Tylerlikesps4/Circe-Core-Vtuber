import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../bus.js";
import { parsePrivmsg, TwitchChat, TwitchSocket } from "../twitch.js";

class FakeSocket implements TwitchSocket {
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

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    queueMicrotask(() => this.emit("close", {}));
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }

  line(line: string): void {
    this.emit("message", { data: line });
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test("parsePrivmsg extracts channel, display name, and message from tags", () => {
  const line =
    "@badge-info=;display-name=CirceFan;color=#FF69B4;emotes=;first-msg=0 :circefan!circefan@circefan.tmi.twitch.tv PRIVMSG #witchesbrew :Hello, Circe!";
  const msg = parsePrivmsg(line);
  assert.ok(msg);
  assert.equal(msg.channel, "#witchesbrew");
  assert.equal(msg.user, "CirceFan");
  assert.equal(msg.message, "Hello, Circe!");
  assert.equal(msg.tags.color, "#FF69B4");
});

test("parsePrivmsg falls back to the login name and ignores non-PRIVMSG", () => {
  const msg = parsePrivmsg(":anon!anon@anon.tmi.twitch.tv PRIVMSG #room :hi there");
  assert.ok(msg);
  assert.equal(msg.user, "anon");
  assert.equal(msg.message, "hi there");
  assert.equal(parsePrivmsg(":tmi.twitch.tv 001 circe :Welcome"), null);
});

test("sends IRC handshake on open and answers PING with PONG", async () => {
  const bus = new EventBus();
  const fake = new FakeSocket("wss://irc-ws.chat.twitch.tv:443");
  const chat = new TwitchChat(bus, {
    channels: ["witchesbrew", "#second"],
    nickname: "circebot",
    wsFactory: () => fake,
  });
  chat.start();
  await tick();
  assert.deepEqual(fake.sent, [
    "CAP REQ :twitch.tv/tags twitch.tv/commands",
    "PASS SCHMOOPIIE",
    "NICK circebot",
    "JOIN #witchesbrew,#second",
  ]);

  fake.line("PING :tmi.twitch.tv");
  assert.equal(fake.sent[fake.sent.length - 1], "PONG :tmi.twitch.tv");

  chat.stop();
});

test("emits twitch-message events for chat lines", async () => {
  const bus = new EventBus();
  const messages: { user: string; message: string }[] = [];
  bus.on((event) => {
    if (event.type === "twitch-message") {
      messages.push({ user: String(event.user), message: String(event.message) });
    }
  });
  const fake = new FakeSocket("wss://irc-ws.chat.twitch.tv:443");
  const chat = new TwitchChat(bus, { channels: ["room"], wsFactory: () => fake });
  chat.start();
  await tick();

  fake.line(":piglet!piglet@piglet.tmi.twitch.tv PRIVMSG #room :oink oink");
  await tick();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].user, "piglet");
  assert.equal(messages[0].message, "oink oink");

  chat.stop();
});

test("reconnects with backoff after the socket closes", async () => {
  const bus = new EventBus();
  const fake = new FakeSocket("wss://irc-ws.chat.twitch.tv:443");
  let created = 0;
  const chat = new TwitchChat(bus, {
    channels: ["room"],
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    wsFactory: () => {
      created += 1;
      return fake;
    },
  });
  chat.start();
  await tick();
  assert.equal(created, 1);

  fake.close();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(created, 2);

  chat.stop();
});
