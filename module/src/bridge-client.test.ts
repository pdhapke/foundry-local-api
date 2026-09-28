// Phase 31 — module/ previously had zero tests. `BridgeClient` itself needs
// a real (or heavily mocked) `WebSocket`/`game.settings` global to exercise
// meaningfully, which is out of scope here (see PLAN.md's Phase 31 notes).
// But bridge-client.ts deliberately extracts two pure functions specifically
// so they're "unit-sanity-checkable without a real timer or socket" — its
// own doc comments say so — and nothing exercised them yet. This file does.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BridgeClient,
  buildBridgeHello,
  buildBridgeConnectionUrl,
  computeBackoffDelayMs,
  DEFAULT_BACKOFF_OPTIONS,
  clearLegacyNonGmApiKey,
  configureBridgeAdminSettingVisibility,
  getConfiguredApiKey,
  registerBridgeSettings,
} from "./bridge-client.js";

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

void describe("buildBridgeConnectionUrl", () => {
  void it("appends a URL-encoded apiKey query param when one is given", () => {
    const url = buildBridgeConnectionUrl("ws://127.0.0.1:3939/bridge", "s3cr3t key/with+chars");
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("apiKey"), "s3cr3t key/with+chars");
  });

  void it("omits the apiKey query param entirely when the key is an empty string", () => {
    const url = buildBridgeConnectionUrl("ws://127.0.0.1:3939/bridge", "");
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.has("apiKey"), false);
    assert.equal(url, "ws://127.0.0.1:3939/bridge");
  });

  void it("preserves an existing path/query on the base URL", () => {
    const url = buildBridgeConnectionUrl("ws://example.test:1234/bridge?foo=bar", "key1");
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/bridge");
    assert.equal(parsed.searchParams.get("foo"), "bar");
    assert.equal(parsed.searchParams.get("apiKey"), "key1");
  });
});

void describe("Track 0 bridge negotiation", () => {
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
    assert.equal(registered.size, 3);
    assert.equal(registered.get("foundry-local-api.bridgeApiKey")?.config, false);
  });

  void it("reveals the administrative key setting only after a GM identity exists", () => {
    const adminSetting: ClientSettings.RegisteredSetting = {
      scope: "client",
      config: false,
    };
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "gm", name: "Gamemaster", isGM: true },
        settings: {
          settings: new Map([["foundry-local-api.bridgeApiKey", adminSetting]]),
        },
      },
    });

    configureBridgeAdminSettingVisibility();
    assert.equal(adminSetting.config, true);

    adminSetting.config = false;
    game.user.isGM = false;
    configureBridgeAdminSettingVisibility();
    assert.equal(adminSetting.config, false);
  });

  void it("reports real user/version identity and requires player opt-in", () => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "izzy", name: "Izzy", isGM: false },
        release: { version: "14.368" },
        system: { id: "dnd5e", version: "6.0.3" },
        modules: new Map([["foundry-local-api", { version: "0.1.0" }]]),
        settings: { get: () => false },
      },
    });
    const message = buildBridgeHello();
    assert.equal(message.identity.userId, "izzy");
    assert.equal(message.identity.lane, "player");
    assert.equal(message.identity.optedIn, false);
    assert.equal(message.versions.foundryVersion, "14.368");
    assert.ok(message.capabilities.includes("ping"));
  });

  void it("keeps consent diagnostics current when the client setting changes", () => {
    let consent = false;
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "izzy", name: "Izzy", isGM: false },
        release: { version: "14.368" },
        system: { id: "dnd5e", version: "6.0.3" },
        modules: new Map([["foundry-local-api", { version: "0.1.0" }]]),
        settings: { get: () => consent },
      },
    });
    const client = new BridgeClient(
      () => "ws://127.0.0.1:3939/bridge",
      () => "",
    );
    assert.equal(client.getDiagnostics().consentGranted, false);
    consent = true;
    client.handleSettingsChanged();
    assert.equal(client.getDiagnostics().consentGranted, true);
    consent = false;
    client.handleSettingsChanged();
    assert.equal(client.getDiagnostics().consentGranted, false);
  });

  void it("clears and verifies a legacy non-GM administrative key", async () => {
    let stored = "legacy-master-key";
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "izzy", name: "Izzy", isGM: false },
        settings: {
          get: () => stored,
          set: async (_namespace: string, _key: string, value: string) => (stored = value),
        },
      },
    });
    assert.equal(await clearLegacyNonGmApiKey(), true);
    assert.equal(stored, "");
  });

  void it("keeps a Foundry GM assigned to TV on the bounded TV lane", async () => {
    let stored = "legacy-master-key";
    Object.defineProperty(globalThis, "sessionStorage", {
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
        settings: {
          get: (_namespace: string, key: string) => (key === "allowRemoteControl" ? true : stored),
          set: async (_namespace: string, _key: string, value: string) => (stored = value),
        },
      },
    });

    const hello = buildBridgeHello();
    assert.equal(hello.identity.lane, "tv");
    assert.equal(hello.identity.isGM, false);
    assert.equal(hello.identity.optedIn, true);
    assert.equal(getConfiguredApiKey(), "");
    assert.equal(await clearLegacyNonGmApiKey(), true);
    assert.equal(stored, "");
  });

  void it("cannot change this browser's lane or identity during enrollment", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: () => "player-client",
        setItem: () => undefined,
      },
    });
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "izzy", name: "Izzy", isGM: false },
        release: { version: "14.368" },
        system: { id: "dnd5e", version: "6.0.3" },
        modules: new Map([["foundry-local-api", { version: "0.1.0" }]]),
        settings: { get: () => true },
      },
    });
    const client = new BridgeClient(
      () => "ws://127.0.0.1:3939/bridge",
      () => "",
    );
    assert.throws(
      () =>
        client.acceptEnrollment({
          action: "deliver",
          targetUserId: "izzy",
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
