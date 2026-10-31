import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_BRIDGE_SESSION_TTL_MS,
  EnrollmentIssueError,
  EnrollmentStore,
  MAX_BRIDGE_SESSION_TTL_MS,
  resolveBridgeSessionTtlMs,
  type EnrollmentIssueRequest,
  type EnrollmentLane,
} from "./enrollment-store.js";

const gm = {
  userId: "X7X4KK7zca5U2Ics",
  clientId: "gm-client",
  isGM: true,
  connected: true,
};

function issueRequest(lane: EnrollmentLane = "player"): EnrollmentIssueRequest {
  return {
    issuer: gm,
    expectedUserId: lane === "player" ? "FakePlayerUser01" : "FakeTvUserId0001",
    expectedClientId: `${lane}-client`,
    lane,
    protocolVersion: 2,
    moduleVersion: { kind: "exact", version: "0.1.0" },
    ttlMs: 60_000,
  };
}

function redeemRequest(
  credential: string,
  lane: EnrollmentLane = "player",
  overrides: Record<string, unknown> = {},
) {
  return {
    credential,
    userId: lane === "player" ? "FakePlayerUser01" : "FakeTvUserId0001",
    lane,
    protocolVersion: 2,
    moduleVersion: "0.1.0",
    path: "/bridge",
    clientId: `${lane}-client`,
    consent: true,
    ...overrides,
  };
}

void describe("EnrollmentStore", () => {
  void it("enrolls player and TV clients with one-time credentials and bounded commands", () => {
    const store = new EnrollmentStore({
      laneCommandAllowlist: { player: ["player.status"], tv: ["tv.viewport"] },
    });
    const player = store.issue(issueRequest("player"));
    const tv = store.issue(issueRequest("tv"));

    const playerResult = store.redeem(redeemRequest(player.credential, "player"));
    const tvResult = store.redeem(redeemRequest(tv.credential, "tv"));

    assert.equal(playerResult.ok, true);
    assert.equal(tvResult.ok, true);
    assert.equal(store.isCommandAllowed("player-client", "player.status"), true);
    assert.equal(store.isCommandAllowed("player-client", "tv.viewport"), false);
    assert.equal(store.isCommandAllowed("tv-client", "tv.viewport"), true);
    assert.equal(store.isCommandAllowed("tv-client", "arbitrary.command"), false);
    assert.equal(store.pendingCount(), 0);
    assert.deepEqual(
      store.listActive().map(({ lane, expectedUserId }) => ({ lane, expectedUserId })),
      [
        { lane: "player", expectedUserId: "FakePlayerUser01" },
        { lane: "tv", expectedUserId: "FakeTvUserId0001" },
      ],
    );
  });

  void it("requires an authenticated connected GM issuer", () => {
    const store = new EnrollmentStore();
    assert.throws(
      () => store.issue({ ...issueRequest(), issuer: { ...gm, connected: false } }),
      (error: unknown) => error instanceof EnrollmentIssueError && error.code === "no_connected_gm",
    );
    assert.throws(
      () => store.issue({ ...issueRequest(), issuer: { ...gm, isGM: false } }),
      (error: unknown) => error instanceof EnrollmentIssueError && error.code === "issuer_not_gm",
    );
  });

  void it("rejects expired credentials", () => {
    let now = 1_000;
    const store = new EnrollmentStore({ now: () => now });
    const issued = store.issue(issueRequest());
    now = 61_000;
    assert.deepEqual(store.redeem(redeemRequest(issued.credential)), {
      ok: false,
      code: "credential_expired",
    });
  });

  void it("rejects replay and reuse by a second browser tab", () => {
    const store = new EnrollmentStore();
    const issued = store.issue(issueRequest());
    assert.equal(store.redeem(redeemRequest(issued.credential)).ok, true);
    assert.deepEqual(store.redeem(redeemRequest(issued.credential)), {
      ok: false,
      code: "credential_replayed",
    });
    assert.deepEqual(
      store.redeem(redeemRequest(issued.credential, "player", { clientId: "duplicate-tab" })),
      { ok: false, code: "credential_reused_by_second_client" },
    );
  });

  void it("binds the first redemption to the exact client probed by the GM", () => {
    const store = new EnrollmentStore();
    const issued = store.issue(issueRequest());
    assert.deepEqual(
      store.redeem(redeemRequest(issued.credential, "player", { clientId: "unprobed-tab" })),
      { ok: false, code: "credential_reused_by_second_client" },
    );
  });

  for (const [name, overrides, code] of [
    ["wrong user", { userId: "another-user" }, "wrong_user"],
    ["wrong lane", { lane: "tv" }, "wrong_lane"],
    ["stale protocol", { protocolVersion: 1 }, "wrong_protocol_version"],
    ["stale module", { moduleVersion: "0.0.9" }, "wrong_module_version"],
    ["REST use", { path: "/api/scenes" }, "wrong_scope"],
    ["MCP use", { path: "/mcp" }, "wrong_scope"],
    ["missing consent", { consent: false }, "consent_required"],
  ] as const) {
    void it(`rejects ${name} and consumes the attempted credential`, () => {
      const store = new EnrollmentStore();
      const issued = store.issue(issueRequest());
      assert.deepEqual(store.redeem(redeemRequest(issued.credential, "player", overrides)), {
        ok: false,
        code,
      });
      assert.deepEqual(store.redeem(redeemRequest(issued.credential)), {
        ok: false,
        code,
      });
    });
  }

  void it("supports an explicit compatible module version range", () => {
    const store = new EnrollmentStore();
    const request = issueRequest();
    request.moduleVersion = {
      kind: "range",
      minInclusive: "0.1.0",
      maxExclusive: "0.2.0",
    };
    const issued = store.issue(request);
    assert.equal(
      store.redeem(redeemRequest(issued.credential, "player", { moduleVersion: "0.1.7" })).ok,
      true,
    );
  });

  void it("enforces first-client-wins even when separate credentials reach duplicate tabs", () => {
    const store = new EnrollmentStore();
    const first = store.issue(issueRequest());
    assert.equal(store.redeem(redeemRequest(first.credential)).ok, true);
    const second = store.issue(issueRequest());
    assert.deepEqual(
      store.redeem(redeemRequest(second.credential, "player", { clientId: "duplicate-tab" })),
      { ok: false, code: "credential_reused_by_second_client" },
    );
  });

  void it("requires fresh enrollment after disconnect and permits explicit reconnect", () => {
    const store = new EnrollmentStore();
    const initial = store.issue(issueRequest());
    assert.equal(store.redeem(redeemRequest(initial.credential)).ok, true);
    assert.equal(store.invalidateClient("player-client"), 1);
    assert.equal(store.isCommandAllowed("player-client", "anything"), false);
    assert.deepEqual(store.redeem(redeemRequest(initial.credential)), {
      ok: false,
      code: "credential_invalidated",
    });

    const reconnect = store.issue(issueRequest());
    assert.equal(store.redeem(redeemRequest(reconnect.credential)).ok, true);
  });

  void it("binds active authorization to the exact client, user, lane, and expiry", () => {
    let now = 1_000;
    const store = new EnrollmentStore({ now: () => now, sessionTtlMs: 1_000 });
    const issued = store.issue({ ...issueRequest(), ttlMs: 1_000 });
    assert.equal(store.redeem(redeemRequest(issued.credential)).ok, true);
    assert.equal(store.isClientAuthorized("player-client", "FakePlayerUser01", "player"), true);
    assert.equal(store.isClientAuthorized("other-client", "FakePlayerUser01", "player"), false);
    assert.equal(store.isClientAuthorized("player-client", "other-user", "player"), false);
    assert.equal(store.isClientAuthorized("player-client", "FakePlayerUser01", "tv"), false);
    now = 2_000;
    assert.equal(store.isClientAuthorized("player-client", "FakePlayerUser01", "player"), false);
    assert.equal(store.listActive().length, 0);
  });

  void it("rotation invalidates prior pending and active enrollment", () => {
    const store = new EnrollmentStore();
    const pending = store.issue(issueRequest());
    const replacement = store.rotate(issueRequest());
    assert.deepEqual(store.redeem(redeemRequest(pending.credential)), {
      ok: false,
      code: "credential_invalidated",
    });
    assert.equal(store.redeem(redeemRequest(replacement.credential)).ok, true);

    const next = store.rotate(issueRequest());
    assert.equal(store.listActive().length, 0);
    assert.equal(store.redeem(redeemRequest(next.credential)).ok, true);
  });

  void it("invalidates all credentials and authorizations for server restart", () => {
    const store = new EnrollmentStore();
    const active = store.issue(issueRequest());
    const pending = store.issue(issueRequest("tv"));
    assert.equal(store.redeem(redeemRequest(active.credential)).ok, true);
    assert.equal(store.invalidateForRestart(), 2);
    assert.deepEqual(store.redeem(redeemRequest(active.credential)), {
      ok: false,
      code: "credential_invalidated",
    });
    assert.deepEqual(store.redeem(redeemRequest(pending.credential, "tv")), {
      ok: false,
      code: "credential_invalidated",
    });
  });

  void it("keeps credentials and digests out of safe projections and events", () => {
    const store = new EnrollmentStore();
    const issued = store.issue(issueRequest());
    store.redeem(
      redeemRequest(issued.credential, "player", {
        userId: "observed-user",
        moduleVersion: "0.0.1",
      }),
    );
    const safeJson = JSON.stringify({
      pending: store.listPending(),
      active: store.listActive(),
      events: store.listEvents(),
    });
    assert.equal(safeJson.includes(issued.credential), false);
    assert.equal(safeJson.includes("credentialDigest"), false);
    assert.equal(safeJson.includes("apiKey"), false);
    assert.match(safeJson, /observed-user/);
    assert.match(safeJson, /wrong_user/);
  });

  void it("redacts a credential smuggled into an observed diagnostic field", () => {
    const store = new EnrollmentStore();
    const issued = store.issue(issueRequest());
    store.redeem(
      redeemRequest(issued.credential, "player", {
        userId: issued.credential,
        clientId: `prefix-${issued.credential}`,
      }),
    );
    const diagnostics = JSON.stringify(store.getDiagnostics());
    assert.equal(diagnostics.includes(issued.credential), false);
    assert.match(diagnostics, /\[redacted\]/);
  });

  void it("reports pending enrollment as module-not-yet-loaded evidence without inventing client data", () => {
    const store = new EnrollmentStore();
    const issued = store.issue(issueRequest("tv"));
    assert.equal(store.pendingCount(), 1);
    assert.deepEqual(store.listPending(), [issued.enrollment]);
    assert.equal("connectedClientId" in store.listPending()[0]!, false);
  });
});

void describe("EnrollmentStore session lifetime", () => {
  void it("keeps an accepted session alive past the one-time credential TTL", () => {
    let now = 1_000;
    const store = new EnrollmentStore({ now: () => now });
    const issued = store.issue({ ...issueRequest(), ttlMs: 10 * 60 * 1000 });
    now = 2_000;
    const redeemed = store.redeem(redeemRequest(issued.credential));
    assert.equal(redeemed.ok, true);
    assert.equal(
      redeemed.ok && redeemed.authorization.expiresAt,
      2_000 + DEFAULT_BRIDGE_SESSION_TTL_MS,
    );

    // Well past the 10 minute credential window, e.g. 20 minutes and 7 hours in.
    now = 1_000 + 20 * 60 * 1000;
    assert.equal(store.isClientAuthorized("player-client", "FakePlayerUser01", "player"), true);
    now = 2_000 + 7 * 60 * 60 * 1000;
    assert.equal(store.isClientAuthorized("player-client", "FakePlayerUser01", "player"), true);
    assert.equal(store.listActive().length, 1);

    // The session still ends at its own expiry.
    now = 2_000 + DEFAULT_BRIDGE_SESSION_TTL_MS;
    assert.equal(store.isClientAuthorized("player-client", "FakePlayerUser01", "player"), false);
    assert.equal(store.listActive().length, 0);
  });

  void it("honours a configured session TTL", () => {
    let now = 0;
    const store = new EnrollmentStore({ now: () => now, sessionTtlMs: 30 * 60 * 1000 });
    const issued = store.issue(issueRequest());
    assert.equal(store.redeem(redeemRequest(issued.credential)).ok, true);
    now = 29 * 60 * 1000;
    assert.equal(store.isClientAuthorized("player-client", "FakePlayerUser01", "player"), true);
    now = 30 * 60 * 1000;
    assert.equal(store.isClientAuthorized("player-client", "FakePlayerUser01", "player"), false);
  });

  void it("rejects an out-of-range session TTL option", () => {
    assert.throws(() => new EnrollmentStore({ sessionTtlMs: 0 }));
    assert.throws(() => new EnrollmentStore({ sessionTtlMs: MAX_BRIDGE_SESSION_TTL_MS + 1 }));
  });

  void it("still refuses a credential after its own expiry, even with a long session TTL", () => {
    let now = 1_000;
    const store = new EnrollmentStore({ now: () => now });
    const issued = store.issue({ ...issueRequest(), ttlMs: 60_000 });
    now = 61_000;
    assert.deepEqual(store.redeem(redeemRequest(issued.credential)), {
      ok: false,
      code: "credential_expired",
    });
    assert.equal(store.isClientAuthorized("player-client", "FakePlayerUser01", "player"), false);
  });

  void it("still refuses replay of a redeemed credential during the long session", () => {
    let now = 1_000;
    const store = new EnrollmentStore({ now: () => now });
    const issued = store.issue(issueRequest());
    assert.equal(store.redeem(redeemRequest(issued.credential)).ok, true);
    assert.deepEqual(store.redeem(redeemRequest(issued.credential)), {
      ok: false,
      code: "credential_replayed",
    });
    now = 1_000 + 60 * 60 * 1000;
    assert.deepEqual(
      store.redeem(redeemRequest(issued.credential, "player", { clientId: "second-tab" })),
      { ok: false, code: "credential_reused_by_second_client" },
    );
    assert.equal(store.isClientAuthorized("player-client", "FakePlayerUser01", "player"), true);
  });

  void it("revocation still ends a long session immediately", () => {
    const store = new EnrollmentStore();
    const first = store.issue(issueRequest());
    assert.equal(store.redeem(redeemRequest(first.credential)).ok, true);
    assert.equal(store.invalidateClient("player-client"), 1);
    assert.equal(store.isClientAuthorized("player-client", "FakePlayerUser01", "player"), false);

    const second = store.issue(issueRequest());
    assert.equal(store.redeem(redeemRequest(second.credential)).ok, true);
    store.rotate(issueRequest());
    assert.equal(store.isClientAuthorized("player-client", "FakePlayerUser01", "player"), false);

    const third = store.issue(issueRequest());
    assert.equal(store.redeem(redeemRequest(third.credential)).ok, true);
    assert.equal(store.invalidateForRestart(), 1);
    assert.equal(store.listActive().length, 0);
  });
});

void describe("resolveBridgeSessionTtlMs", () => {
  void it("defaults to 8 hours when unset or blank", () => {
    assert.equal(DEFAULT_BRIDGE_SESSION_TTL_MS, 8 * 60 * 60 * 1000);
    assert.deepEqual(resolveBridgeSessionTtlMs(undefined), {
      ttlMs: DEFAULT_BRIDGE_SESSION_TTL_MS,
      source: "default",
    });
    assert.deepEqual(resolveBridgeSessionTtlMs("  "), {
      ttlMs: DEFAULT_BRIDGE_SESSION_TTL_MS,
      source: "default",
    });
  });

  void it("accepts a positive integer override", () => {
    assert.deepEqual(resolveBridgeSessionTtlMs("3600000"), { ttlMs: 3_600_000, source: "env" });
    assert.deepEqual(resolveBridgeSessionTtlMs(" 900000 "), { ttlMs: 900_000, source: "env" });
  });

  void it("falls back to the default for invalid values", () => {
    for (const raw of ["0", "-5", "abc", "1.5", "1e6", "NaN", "12ms"]) {
      assert.deepEqual(
        resolveBridgeSessionTtlMs(raw),
        { ttlMs: DEFAULT_BRIDGE_SESSION_TTL_MS, source: "invalid" },
        raw,
      );
    }
  });

  void it("clamps values above 24 hours", () => {
    assert.deepEqual(resolveBridgeSessionTtlMs(String(MAX_BRIDGE_SESSION_TTL_MS + 1)), {
      ttlMs: MAX_BRIDGE_SESSION_TTL_MS,
      source: "clamped",
    });
    assert.deepEqual(resolveBridgeSessionTtlMs("99999999999999999999"), {
      ttlMs: MAX_BRIDGE_SESSION_TTL_MS,
      source: "clamped",
    });
  });
});
