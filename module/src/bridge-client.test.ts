// Phase 31 — module/ previously had zero tests. `BridgeClient` itself needs
// a real (or heavily mocked) `WebSocket`/`game.settings` global to exercise
// meaningfully, which is out of scope here (see PLAN.md's Phase 31 notes).
// But bridge-client.ts deliberately extracts two pure functions specifically
// so they're "unit-sanity-checkable without a real timer or socket" — its
// own doc comments say so — and nothing exercised them yet. This file does.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  BridgeClient,
  buildBridgeHello,
  computeBackoffDelayMs,
  DEFAULT_BACKOFF_OPTIONS,
  deriveBridgeUrl,
  getClientId,
  registerBridgeSettings,
  rotateClientId,
  stageIdentityHandoff,
} from "./bridge-client.js";

function storage(values = new Map<string, string>()) {
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

const savedLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const savedSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

afterEach(() => {
  for (const [name, descriptor] of [
    ["localStorage", savedLocalStorage],
    ["sessionStorage", savedSessionStorage],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

void describe("computeBackoffDelayMs", () => {
  void it("never exceeds the capped exponential ceiling for a given attempt", () => {
    const options = { baseDelayMs: 500, maxDelayMs: 30_000 };
    for (let attempt = 0; attempt < 10; attempt++) {
      const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
      for (let sample = 0; sample < 25; sample++) {
        const delay = computeBackoffDelayMs(attempt, options);
        assert.ok(delay >= 0, `attempt ${attempt} produced a negative delay: ${delay}`);
        assert.ok(
          delay < ceiling + 1,
          `attempt ${attempt} exceeded its ceiling (${ceiling}): ${delay}`,
        );
      }
    }
  });

  void it("caps growth at maxDelayMs once the exponential exceeds it", () => {
    const options = { baseDelayMs: 500, maxDelayMs: 2_000 };
    // 500 * 2^10 is far past maxDelayMs, so the ceiling must be maxDelayMs itself.
    for (let sample = 0; sample < 25; sample++) {
      const delay = computeBackoffDelayMs(10, options);
      assert.ok(
        delay <= options.maxDelayMs,
        `delay ${delay} exceeded maxDelayMs ${options.maxDelayMs}`,
      );
    }
  });

  void it("treats a negative attempt the same as attempt 0 (no negative exponent)", () => {
    for (let sample = 0; sample < 25; sample++) {
      const delay = computeBackoffDelayMs(-5, DEFAULT_BACKOFF_OPTIONS);
      assert.ok(delay >= 0 && delay <= DEFAULT_BACKOFF_OPTIONS.baseDelayMs);
    }
  });

  void it("defaults to DEFAULT_BACKOFF_OPTIONS when no options are given", () => {
    for (let sample = 0; sample < 25; sample++) {
      const delay = computeBackoffDelayMs(0);
      assert.ok(delay >= 0 && delay <= DEFAULT_BACKOFF_OPTIONS.baseDelayMs);
    }
  });
});

void describe("deriveBridgeUrl", () => {
  void it("keeps localhost aligned with the Foundry page and forces the bridge port/path", () => {
    assert.equal(
      deriveBridgeUrl({ protocol: "http:", hostname: "localhost" }),
      "ws://localhost:3939/bridge",
    );
  });

  void it("keeps 127.0.0.1 aligned and uses secure WebSockets for an HTTPS page", () => {
    assert.equal(
      deriveBridgeUrl({ protocol: "https:", hostname: "127.0.0.1" }),
      "wss://127.0.0.1:3939/bridge",
    );
  });

  void it("supports the exact IPv6 loopback hostname", () => {
    assert.equal(
      deriveBridgeUrl({ protocol: "http:", hostname: "[::1]" }),
      "ws://[::1]:3939/bridge",
    );
    assert.equal(deriveBridgeUrl({ protocol: "http:", hostname: "::1" }), "ws://[::1]:3939/bridge");
  });

  void it("supports a configured hostname in the reserved localhost namespace", () => {
    assert.equal(
      deriveBridgeUrl({ protocol: "http:", hostname: "foundry.localhost" }),
      "ws://foundry.localhost:3939/bridge",
    );
  });

  void it("does not silently cross hostnames when the Foundry page host changes", () => {
    assert.notEqual(
      deriveBridgeUrl({ protocol: "http:", hostname: "localhost" }),
      deriveBridgeUrl({ protocol: "http:", hostname: "127.0.0.1" }),
    );
  });

  void it("rejects remote, deceptive, and unsupported page locations", () => {
    for (const hostname of [
      "example.test",
      "localhost.example.test",
      "127.0.0.1.example.test",
      "127.0.0.2",
    ]) {
      assert.throws(
        () => deriveBridgeUrl({ protocol: "http:", hostname }),
        /not an approved loopback host/,
      );
    }
    assert.throws(
      () => deriveBridgeUrl({ protocol: "file:", hostname: "localhost" }),
      /protocol is not supported/,
    );
  });
});

void describe("Track 0 bridge negotiation", () => {
  void it("persists a client identity across fresh browser sessions", () => {
    const persistent = storage();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: persistent,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: storage(),
    });
    const first = getClientId();

    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: storage(),
    });
    assert.equal(getClientId(), first);
    assert.equal(persistent.getItem("foundry-local-api.clientId"), first);
  });

  void it("migrates the prior session identity and rotates it with collision protection", () => {
    const persistent = storage();
    const session = storage(
      new Map<string, string>([["foundry-local-api.clientId", "legacy-player-client"]]),
    );
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: persistent,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: session,
    });

    assert.equal(getClientId(), "legacy-player-client");
    assert.equal(persistent.getItem("foundry-local-api.clientId"), "legacy-player-client");
    const rotated = rotateClientId("legacy-player-client");
    assert.notEqual(rotated, "legacy-player-client");
    assert.equal(persistent.getItem("foundry-local-api.clientId"), rotated);
    assert.throws(() => rotateClientId("legacy-player-client"), /identity changed before rotation/);
  });

  void it("uses the persistent identity over a stale session identity and repairs the session", () => {
    const persistent = storage(
      new Map<string, string>([["foundry-local-api.clientId", "persistent-client"]]),
    );
    const session = storage(
      new Map<string, string>([["foundry-local-api.clientId", "stale-session-client"]]),
    );
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: persistent,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: session,
    });

    assert.equal(getClientId(), "persistent-client");
    assert.equal(session.getItem("foundry-local-api.clientId"), "persistent-client");
  });

  void it("registers settings during Foundry 14 init without reading the null game.user", () => {
    const registered = new Map<string, ClientSettings.RegisterOptions<unknown>>();
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: null,
        settings: {
          register: (
            namespace: string,
            key: string,
            data: ClientSettings.RegisterOptions<unknown>,
          ) => registered.set(`${namespace}.${key}`, data),
        },
      },
    });

    assert.doesNotThrow(() => registerBridgeSettings());
    assert.equal(registered.size, 1);
    assert.equal(registered.has("foundry-local-api.bridgeUrl"), false);
    assert.equal(registered.has("foundry-local-api.bridgeApiKey"), false);
    assert.equal(registered.has("foundry-local-api.gmBridgeCode"), false);
  });

  void it("reports real user/version identity and requires player opt-in", () => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "player-1", name: "Test Player", isGM: false },
        release: { version: "14.368" },
        system: { id: "dnd5e", version: "6.0.3" },
        modules: new Map([["foundry-local-api", { version: "0.1.0" }]]),
        settings: { get: () => false },
      },
    });
    const message = buildBridgeHello();
    assert.equal(message.identity.userId, "player-1");
    assert.equal(message.identity.lane, "player");
    assert.equal(message.identity.optedIn, false);
    assert.equal(message.versions.foundryVersion, "14.368");
    assert.ok(message.capabilities.includes("ping"));
  });

  void it("sends the claimed world for independent GM session verification without credentials", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage(new Map([["foundry-local-api.clientId", "gm-client"]])),
    });
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "gm", name: "Gamemaster", isGM: true },
        world: { id: "world-1" },
        release: { version: "14.368" },
        system: { id: "dnd5e", version: "6.0.3" },
        modules: new Map([["foundry-local-api", { version: "0.1.0" }]]),
        settings: { get: () => false },
      },
    });
    const hello = buildBridgeHello();
    assert.equal(hello.worldId, "world-1");
    assert.equal("gmBridgeCredential" in hello, false);
  });

  void it("sends an adoption proof only from the browser session that staged it", () => {
    const persistent = storage(
      new Map([["foundry-local-api.clientId", "00000000-0000-4000-8000-000000000001"]]),
    );
    const ownerSession = storage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: persistent });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: ownerSession,
    });
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "gm", name: "Gamemaster", isGM: true },
        world: { id: "test-world" },
        release: { version: "14.368" },
        system: { id: "dnd5e", version: "6.0.3" },
        modules: new Map([["foundry-local-api", { version: "0.1.0" }]]),
        settings: { get: () => true },
      },
    });
    const proof = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    stageIdentityHandoff("00000000-0000-4000-8000-000000000001", proof);
    const ownerHello = buildBridgeHello();
    assert.equal(ownerHello.identityHandoffProof, proof);

    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: storage(),
    });
    const racingHello = buildBridgeHello();
    assert.equal(racingHello.identityHandoffProof, undefined);
    assert.notEqual(racingHello.browserSessionId, ownerHello.browserSessionId);
  });

  void it("keeps consent diagnostics current when the client setting changes", () => {
    let consent = false;
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "player-1", name: "Test Player", isGM: false },
        release: { version: "14.368" },
        system: { id: "dnd5e", version: "6.0.3" },
        modules: new Map([["foundry-local-api", { version: "0.1.0" }]]),
        settings: { get: () => consent },
      },
    });
    const client = new BridgeClient(() => "ws://127.0.0.1:3939/bridge");
    assert.equal(client.getDiagnostics().consentGranted, false);
    consent = true;
    client.handleSettingsChanged();
    assert.equal(client.getDiagnostics().consentGranted, true);
    consent = false;
    client.handleSettingsChanged();
    assert.equal(client.getDiagnostics().consentGranted, false);
  });

  void it("keeps a Foundry GM assigned to TV on the bounded TV lane", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => "tv-client",
        setItem: () => undefined,
      },
    });
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "tv", name: "TV", isGM: true },
        release: { version: "14.368" },
        system: { id: "dnd5e", version: "6.0.3" },
        modules: new Map([["foundry-local-api", { version: "0.1.0" }]]),
        settings: { get: () => true },
      },
    });

    const hello = buildBridgeHello();
    assert.equal(hello.identity.lane, "tv");
    assert.equal(hello.identity.isGM, false);
    assert.equal(hello.identity.optedIn, true);
  });

  void it("cannot change this browser's lane or identity during enrollment", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => "player-client",
        setItem: () => undefined,
      },
    });
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "player-1", name: "Test Player", isGM: false },
        release: { version: "14.368" },
        system: { id: "dnd5e", version: "6.0.3" },
        modules: new Map([["foundry-local-api", { version: "0.1.0" }]]),
        settings: { get: () => true },
      },
    });
    const client = new BridgeClient(() => "ws://127.0.0.1:3939/bridge");
    assert.throws(
      () =>
        client.acceptEnrollment({
          action: "deliver",
          targetUserId: "player-1",
          expectedLane: "tv",
          expectedClientId: "player-client",
          credential: "opaque",
          expiresAt: "2026-09-28T02:00:00.000Z",
          protocolVersion: 2,
          moduleVersion: "0.1.0",
        }),
      /does not match this client/,
    );
  });
});
