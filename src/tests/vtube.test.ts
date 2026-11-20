import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../bus.js";
import { VtubeStudioDriver, VtubeSocket } from "../vtube.js";
import { AnimationCue } from "../expression.js";

interface Wire {
  messageType?: string;
  requestID?: string;
  data?: Record<string, unknown>;
}

class FakeSocket implements VtubeSocket {
  sent: string[] = [];
  closed = false;
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
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close", {}));
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }

  respond(request: Wire, data: Record<string, unknown>): void {
    const response = {
      apiName: "VTubeStudioPublicAPI",
      apiVersion: "1.0",
      requestID: request.requestID,
      messageType: (request.messageType ?? "").replace(/Request$/, "Response"),
      data,
    };
    this.emit("message", { data: JSON.stringify(response) });
  }

  last(): Wire {
    return JSON.parse(this.sent[this.sent.length - 1]) as Wire;
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function cue(expression: string): AnimationCue {
  return { marker: expression, kind: "vocal", expression, mood: "playful", intensity: 0.8 };
}

async function authenticate(fake: FakeSocket, driver: VtubeStudioDriver): Promise<void> {
  await tick();
  const tokenRequest = fake.last();
  assert.equal(tokenRequest.messageType, "AuthenticationTokenRequest");
  fake.respond(tokenRequest, { authenticationToken: "secret" });
  await tick();
  const authRequest = fake.last();
  assert.equal(authRequest.messageType, "AuthenticationRequest");
  fake.respond(authRequest, { authenticated: true });
  await tick();
  assert.equal(driver.isReady, true);
}

test("completes the VTS auth handshake and triggers mapped hotkeys", async () => {
  const bus = new EventBus();
  const fake = new FakeSocket("ws://127.0.0.1:8001");
  const driver = new VtubeStudioDriver(bus, {
    authToken: "secret",
    wsFactory: () => fake,
  });
  driver.start();

  await tick();
  const tokenRequest = fake.last();
  assert.equal(tokenRequest.messageType, "AuthenticationTokenRequest");
  assert.equal(tokenRequest.data?.pluginName, "CirceCore");
  assert.equal(tokenRequest.data?.authenticationToken, "secret");

  fake.respond(tokenRequest, { authenticationToken: "secret" });
  await tick();
  assert.equal(fake.last().messageType, "AuthenticationRequest");
  fake.respond(fake.last(), { authenticated: true });
  await tick();
  assert.equal(driver.isReady, true);

  const hotkeyRequest = fake.last();
  assert.equal(hotkeyRequest.messageType, "HotkeysInCurrentModelRequest");
  fake.respond(hotkeyRequest, {
    availableHotkeys: [{ name: "Circe Joy", hotkeyID: "hk-joy" }],
  });
  await tick();

  driver.handleCue(cue("joy"));
  await tick();
  const trigger = fake.last();
  assert.equal(trigger.messageType, "HotkeyTriggerRequest");
  assert.equal(trigger.data?.hotkeyID, "hk-joy");

  driver.stop();
});

test("maps expressions via the map config and activates expression files", async () => {
  const bus = new EventBus();
  const fake = new FakeSocket("ws://127.0.0.1:8001");
  const driver = new VtubeStudioDriver(bus, {
    authToken: "secret",
    map: { smug: { kind: "expression", name: "Smug.exp3.json" } },
    defaultKind: "expression",
    reset: "Idle.exp3.json",
    holdMs: 20,
    wsFactory: () => fake,
  });
  driver.start();
  await authenticate(fake, driver);

  const hotkeyRequest = fake.last();
  fake.respond(hotkeyRequest, { availableHotkeys: [] });
  await tick();

  driver.handleCue(cue("smug"));
  await tick();
  const activate = fake.last();
  assert.equal(activate.messageType, "ExpressionStateRequest");
  assert.equal(activate.data?.expressionFile, "Smug.exp3.json");
  assert.equal(activate.data?.active, true);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const reset = fake.last();
  assert.equal(reset.messageType, "ExpressionStateRequest");
  assert.equal(reset.data?.expressionFile, "Idle.exp3.json");

  driver.stop();
});

test("queues cues until authenticated, then flushes them", async () => {
  const bus = new EventBus();
  const fake = new FakeSocket("ws://127.0.0.1:8001");
  const driver = new VtubeStudioDriver(bus, { authToken: "secret", wsFactory: () => fake });
  driver.start();
  await tick();

  driver.handleCue(cue("giggle"));

  const tokenRequest = fake.last();
  fake.respond(tokenRequest, { authenticationToken: "secret" });
  await tick();
  fake.respond(fake.last(), { authenticated: true });
  await tick();

  const hotkeyRequest = fake.last();
  assert.equal(hotkeyRequest.messageType, "HotkeysInCurrentModelRequest");
  fake.respond(hotkeyRequest, {
    availableHotkeys: [{ name: "circe_giggle", hotkeyID: "hk-g" }],
  });
  await tick();

  const trigger = fake.last();
  assert.equal(trigger.messageType, "HotkeyTriggerRequest");
  assert.equal(trigger.data?.hotkeyID, "hk-g");

  driver.stop();
});

test("emits vtube-error for unknown hotkeys and API errors", async () => {
  const bus = new EventBus();
  const errors: string[] = [];
  bus.on((event) => {
    if (event.type === "vtube-error") errors.push(String(event.message));
  });

  const fake = new FakeSocket("ws://127.0.0.1:8001");
  const driver = new VtubeStudioDriver(bus, { authToken: "secret", wsFactory: () => fake });
  driver.start();
  await authenticate(fake, driver);

  const hotkeyRequest = fake.last();
  fake.respond(hotkeyRequest, { availableHotkeys: [] });
  await tick();

  driver.handleCue(cue("joy"));
  await tick();
  assert.ok(errors.some((e) => e.includes('unknown hotkey "circe_joy"')));

  const before = errors.length;
  fake.emit("message", {
    data: JSON.stringify({
      apiName: "VTubeStudioPublicAPI",
      messageType: "APIError",
      data: { message: "test error" },
    }),
  });
  assert.ok(errors.length > before);
  assert.ok(errors.some((e) => e.includes("test error")));

  driver.stop();
});

test("reconnects with backoff after the socket closes", async () => {
  const bus = new EventBus();
  const fake = new FakeSocket("ws://127.0.0.1:8001");
  let created = 0;
  const factory = () => {
    created += 1;
    return fake;
  };
  const driver = new VtubeStudioDriver(bus, {
    authToken: "secret",
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    wsFactory: factory,
  });
  driver.start();
  await tick();
  assert.equal(created, 1);

  fake.close();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(created, 2);
  assert.equal(fake.closed, true);

  driver.stop();
  assert.equal(driver.isReady, false);
});

test("polls live parameters and emits vtube-param events", async () => {
  const bus = new EventBus();
  const params: { name: string; value: number }[] = [];
  bus.on((event) => {
    if (event.type === "vtube-param") {
      params.push({ name: String(event.name), value: Number(event.value) });
    }
  });

  const fake = new FakeSocket("ws://127.0.0.1:8001");
  const driver = new VtubeStudioDriver(bus, {
    authToken: "secret",
    pollParams: ["MouthOpen"],
    pollIntervalMs: 10,
    wsFactory: () => fake,
  });
  driver.start();
  await authenticate(fake, driver);

  const hotkeyRequest = fake.last();
  fake.respond(hotkeyRequest, { availableHotkeys: [] });
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 60));

  let responded = 0;
  for (let i = 0; i < 3; i++) {
    const last = fake.last();
    if (last.messageType !== "ParameterValueRequest") break;
    fake.respond(last, { name: "MouthOpen", value: 0.5 + i });
    responded += 1;
    await tick();
  }

  assert.ok(responded >= 1, "expected at least one parameter poll to complete");
  assert.ok(params.length >= 1);
  assert.equal(params[0].name, "MouthOpen");
  assert.equal(params[0].value, 0.5);
  assert.equal(
    driver.params()["MouthOpen"],
    params[params.length - 1].value,
  );

  driver.stop();
});

test("polls the face tracker when enabled", async () => {
  const bus = new EventBus();
  const faces: { found: boolean }[] = [];
  bus.on((event) => {
    if (event.type === "vtube-face") {
      faces.push({ found: Boolean(event.found) });
    }
  });

  const fake = new FakeSocket("ws://127.0.0.1:8001");
  const driver = new VtubeStudioDriver(bus, {
    authToken: "secret",
    pollFace: true,
    pollIntervalMs: 10,
    wsFactory: () => fake,
  });
  driver.start();
  await authenticate(fake, driver);

  const hotkeyRequest = fake.last();
  fake.respond(hotkeyRequest, { availableHotkeys: [] });
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 40));

  const poll = fake.last();
  assert.equal(poll.messageType, "FaceFoundRequest");
  fake.respond(poll, { found: true, mouthOpen: 0.3 });
  await tick();

  assert.ok(faces.length >= 1);
  assert.equal(faces[faces.length - 1].found, true);
  assert.equal(driver.face()?.mouthOpen, 0.3);

  driver.stop();
});
