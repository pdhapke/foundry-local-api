import assert from "node:assert/strict";
import test from "node:test";
import { BridgeClient } from "../bridge-client.js";

class FakeSocket {
  static readonly OPEN = 1;
  static latest: FakeSocket;
  readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, (event: unknown) => void>();
  constructor(readonly url: string) {
    FakeSocket.latest = this;
  }
  addEventListener(name: string, callback: (event: unknown) => void) {
    this.listeners.set(name, callback);
  }
  send(value: string) {
    this.sent.push(value);
  }
  emit(name: string, event: unknown = {}) {
    this.listeners.get(name)?.(event);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}
void test("browser extensions register before hello, use acknowledged identity and isolate bounded private messages", async (t) => {
  const user = { id: "gm", name: "GM", isGM: true };
  for (const [name, value] of Object.entries({
    game: {
      user,
      world: { id: "fixture-world" },
      release: { version: "14" },
      system: { id: "fixture", version: "1" },
      modules: new Map([["foundry-local-api", { version: "0.1.0" }]]),
      settings: { get: () => false },
    },
    WebSocket: FakeSocket,
    localStorage: { getItem: () => "extension-client", setItem: (): void => undefined },
    sessionStorage: {
      getItem: () => null,
      setItem: (): void => undefined,
      removeItem: () => undefined,
    },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const client = new BridgeClient(() => "ws://127.0.0.1:3939/bridge");
  const api = client.extensionApi();
  const statuses: string[] = [];
  const disposeStatus = api.onStatus((status) => statuses.push(status));
  const disposeCommand = api.registerCommand("fixtureExtensionCommand", () => ({ ok: true }));
  t.after(() => {
    client.disconnect();
    disposeStatus();
    disposeCommand();
  });
  assert.throws(() => api.sendPrivate({ kind: "fixture.private", value: "synthetic-only" }));
  assert.throws(() => api.registerCommand("ping", () => undefined));
  client.connect();
  const socket = FakeSocket.latest;
  socket.emit("open");
  const hello = JSON.parse(socket.sent[0]!) as { capabilities: string[] };
  assert.ok(hello.capabilities.includes("fixtureExtensionCommand"));
  socket.emit("message", {
    data: JSON.stringify({
      kind: "negotiation",
      accepted: true,
      at: new Date().toISOString(),
      protocolVersion: "fixture",
      moduleVersion: "0.1.0",
    }),
  });
  await Promise.resolve();
  assert.equal(api.identity().connected, true);
  api.sendPrivate({ kind: "fixture.private", value: "synthetic-only" });
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), {
    kind: "extension-private",
    channel: "fixture.private",
    payload: { kind: "fixture.private", value: "synthetic-only" },
  });
  assert.throws(() => api.sendPrivate({ kind: "fixture.private", value: "x".repeat(17000) }));
  user.id = "other-gm";
  assert.equal(api.identity().connected, false);
  assert.throws(() => api.sendPrivate({ kind: "fixture.private", value: "synthetic-only" }));
  user.id = "gm";
  let privateReplies = 0;
  const disposeMessage = api.onMessage((value) => {
    if ((value as { kind?: string }).kind === "fixture.reply") {
      privateReplies++;
      return true;
    }
    return false;
  });
  socket.emit("message", { data: JSON.stringify({ kind: "fixture.reply" }) });
  await Promise.resolve();
  assert.equal(privateReplies, 1);
  disposeMessage();
  client.disconnect();
  assert.equal(api.identity().connected, false);
  assert.deepEqual(statuses, ["connecting", "connected", "disconnected"]);
});
