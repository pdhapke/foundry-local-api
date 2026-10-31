import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { adoptExactClientIdentity, adoptExactEnrolledClientIdentity } from "./client-identity.js";

const current = "6489d1c8-8937-42ce-8126-ef036fdfadd5";
const desired = "00000000-0000-4000-8000-000000000001";
const proof = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const savedGame = Object.getOwnPropertyDescriptor(globalThis, "game");
const savedLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const savedSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

function install(isGM = true) {
  const values = new Map<string, string>([["foundry-local-api.clientId", current]]);
  const sessionValues = new Map<string, string>();
  const local = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const session = {
    getItem: (key: string) => sessionValues.get(key) ?? null,
    setItem: (key: string, value: string) => sessionValues.set(key, value),
    removeItem: (key: string) => sessionValues.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: session });
  Object.defineProperty(globalThis, "game", {
    configurable: true,
    value: { user: { id: "gm-user", name: "Gamemaster", isGM } },
  });
  return { values, sessionValues };
}

afterEach(() => {
  for (const [name, descriptor] of [
    ["game", savedGame],
    ["localStorage", savedLocal],
    ["sessionStorage", savedSession],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

void describe("exact GM client identity adoption", () => {
  void it("durably adopts once and returns an identity-bound replay", () => {
    const { values, sessionValues } = install();
    const input = {
      correlationId: "identity-adopt-0001",
      expectedClientId: current,
      desiredClientId: desired,
      identityHandoffProof: proof,
    };
    const first = adoptExactClientIdentity(input);
    const replay = adoptExactClientIdentity(input);
    assert.equal(first.executingClientId, current);
    assert.equal(first.adoptedClientId, desired);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(values.get("foundry-local-api.clientId"), desired);
    assert.equal(values.get("foundry-local-api.identity-adoptions.v1")?.includes(proof), false);
    assert.equal(sessionValues.get("foundry-local-api.identityHandoff.v1")?.includes(proof), true);
  });

  void it("rejects non-GM callers and changed correlation replay", () => {
    install(false);
    assert.throws(
      () =>
        adoptExactClientIdentity({
          correlationId: "identity-adopt-0002",
          expectedClientId: current,
          desiredClientId: desired,
          identityHandoffProof: proof,
        }),
      (error: unknown) => (error as { code?: string }).code === "PERMISSION_DENIED",
    );

    install();
    adoptExactClientIdentity({
      correlationId: "identity-adopt-0003",
      expectedClientId: current,
      desiredClientId: desired,
      identityHandoffProof: proof,
    });
    assert.throws(
      () =>
        adoptExactClientIdentity({
          correlationId: "identity-adopt-0003",
          expectedClientId: current,
          desiredClientId: "11111111-1111-4111-8111-111111111111",
          identityHandoffProof: proof,
        }),
      (error: unknown) => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT",
    );
  });

  void it("adopts only for the exact consenting player or TV binding", () => {
    const { values } = install(false);
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "tv-user", name: "TV", isGM: true },
        settings: { get: () => true },
      },
    });
    const input = {
      correlationId: "identity-adopt-tv-0001",
      expectedClientId: current,
      desiredClientId: desired,
      expectedUserId: "tv-user",
      expectedLane: "tv" as const,
      identityHandoffProof: proof,
    };
    assert.equal(adoptExactEnrolledClientIdentity(input).adoptedClientId, desired);
    assert.equal(values.get("foundry-local-api.clientId"), desired);

    install(false);
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "tv-user", name: "TV", isGM: false },
        settings: { get: () => false },
      },
    });
    assert.throws(
      () => adoptExactEnrolledClientIdentity({ ...input, correlationId: "identity-adopt-tv-0002" }),
      (error: unknown) => (error as { code?: string }).code === "PERMISSION_DENIED",
    );
  });
});
