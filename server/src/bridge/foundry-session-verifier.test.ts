import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";

import { LocalFoundrySessionVerifier } from "./foundry-session-verifier.js";

function request(origin: string, cookies: string[]): IncomingMessage {
  return {
    headers: { origin, cookie: cookies.join("; ") },
    rawHeaders: cookies.flatMap((cookie) => ["Cookie", cookie]),
  } as IncomingMessage;
}

function validExchange(userId = "gm-1", role = 4, name = "Alice") {
  return {
    session: { sessionId: "discard-me", userId },
    joinData: {
      userId,
      world: { id: "world-1" },
      users: [{ _id: userId, name, role }],
    },
  };
}

function verifier(
  overrides: Partial<ConstructorParameters<typeof LocalFoundrySessionVerifier>[0]> = {},
) {
  return new LocalFoundrySessionVerifier({
    allowedFoundryOrigins: [
      "http://localhost:30000",
      "http://127.0.0.1:30000",
      "http://[::1]:30000",
    ],
    preflightImpl: async () => 200,
    sessionExchange: async () => validExchange(),
    lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
    ...overrides,
  });
}

void describe("LocalFoundrySessionVerifier", () => {
  void it("forwards only the session cookie and returns sanitized exact identity", async () => {
    const observed: Array<{ stage: string; cookie: string; address: string }> = [];
    const instance = verifier({
      preflightImpl: async (_origin, cookie, _timeout, target) => {
        observed.push({ stage: "http", cookie, address: target.address });
        return 200;
      },
      sessionExchange: async (_origin, cookie, _timeout, target) => {
        observed.push({ stage: "socket", cookie, address: target.address });
        return validExchange();
      },
    });
    const result = await instance.verify(
      request("http://localhost:30000", ["theme=dark; session=opaque.value; preference=x"]),
    );
    assert.deepEqual(result, {
      ok: true,
      identity: {
        worldId: "world-1",
        userId: "gm-1",
        userName: "Alice",
        role: 4,
        isGM: true,
      },
    });
    assert.deepEqual(observed, [
      { stage: "http", cookie: "session=opaque.value", address: "127.0.0.1" },
      { stage: "socket", cookie: "session=opaque.value", address: "127.0.0.1" },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /opaque|discard-me/);
  });

  void it("supports exact localhost, IPv4, and IPv6 allowlisted origins", async () => {
    for (const origin of [
      "http://localhost:30000",
      "http://127.0.0.1:30000",
      "http://[::1]:30000",
    ]) {
      assert.equal((await verifier().verify(request(origin, ["session=value"]))).ok, true);
    }
  });

  void it("rejects missing, duplicate-header, duplicate-session, and malformed cookies", async () => {
    assert.deepEqual(await verifier().verify(request("http://localhost:30000", [])), {
      ok: false,
      code: "missing_cookie",
    });
    assert.deepEqual(
      await verifier().verify(request("http://localhost:30000", ["session=a", "session=b"])),
      { ok: false, code: "malformed_cookie" },
    );
    assert.deepEqual(
      await verifier().verify(request("http://localhost:30000", ["session=a; session=b"])),
      { ok: false, code: "malformed_cookie" },
    );
    assert.deepEqual(
      await verifier().verify(request("http://localhost:30000", ["session=a\u0001b"])),
      { ok: false, code: "malformed_cookie" },
    );
    for (const value of ["a b", "a,b", '"quoted"', "caf\u00e9"]) {
      assert.deepEqual(
        await verifier().verify(request("http://localhost:30000", [`session=${value}`])),
        { ok: false, code: "malformed_cookie" },
      );
    }
    assert.deepEqual(
      await verifier().verify(request("http://localhost:30000", ["theme=a b; session=valid"])),
      { ok: false, code: "malformed_cookie" },
    );
  });

  void it("rejects redirect, logged-out, expired/revoked, and malformed Foundry responses", async () => {
    const redirected = verifier({ preflightImpl: async () => 302 });
    assert.deepEqual(await redirected.verify(request("http://localhost:30000", ["session=x"])), {
      ok: false,
      code: "redirect",
    });
    for (const exchange of [
      { session: null, joinData: null },
      { session: { sessionId: "x", userId: "gm-1" }, joinData: { userId: null } },
      { session: { sessionId: "x", userId: "gm-1" }, joinData: { userId: "other" } },
    ]) {
      const result = await verifier({ sessionExchange: async () => exchange }).verify(
        request("http://localhost:30000", ["session=x"]),
      );
      assert.equal(result.ok, false);
    }
  });

  void it("returns player authority without elevating it to GM", async () => {
    const result = await verifier({
      sessionExchange: async () => validExchange("player-1", 1),
    }).verify(request("http://localhost:30000", ["session=x"]));
    assert.equal(result.ok && result.identity.isGM, false);
  });

  void it("refuses wrong origins and configured hostnames resolving remotely before forwarding cookies", async () => {
    let forwarded = false;
    const instance = new LocalFoundrySessionVerifier({
      allowedFoundryOrigins: ["http://foundry.internal:30000"],
      lookupImpl: async () => [{ address: "203.0.113.7", family: 4 }],
      preflightImpl: async () => {
        forwarded = true;
        return 200;
      },
      sessionExchange: async () => {
        forwarded = true;
        return validExchange();
      },
    });
    assert.deepEqual(
      await instance.verify(request("http://foundry.internal:30000", ["session=secret"])),
      { ok: false, code: "unavailable" },
    );
    assert.equal(forwarded, false);
    assert.deepEqual(
      await instance.verify(request("http://foundry.internal.evil:30000", ["session=secret"])),
      { ok: false, code: "unavailable" },
    );
  });

  void it("pins one verified loopback address across HTTP and Socket.IO despite a rebind", async () => {
    let lookups = 0;
    const observed: string[] = [];
    const instance = new LocalFoundrySessionVerifier({
      allowedFoundryOrigins: ["http://foundry.internal:30000"],
      lookupImpl: async () => {
        lookups += 1;
        return lookups === 1
          ? [{ address: "127.0.0.1", family: 4 }]
          : [{ address: "203.0.113.9", family: 4 }];
      },
      preflightImpl: async (_origin, _cookie, _timeout, target) => {
        observed.push(`http:${target.address}`);
        return 200;
      },
      sessionExchange: async (_origin, _cookie, _timeout, target) => {
        observed.push(`socket:${target.address}`);
        return validExchange();
      },
    });
    assert.equal(
      (await instance.verify(request("http://foundry.internal:30000", ["session=x"]))).ok,
      true,
    );
    assert.equal(lookups, 1);
    assert.deepEqual(observed, ["http:127.0.0.1", "socket:127.0.0.1"]);
  });

  void it("bounds DNS resolution inside the verification timeout", async () => {
    const instance = new LocalFoundrySessionVerifier({
      allowedFoundryOrigins: ["http://foundry.internal:30000"],
      timeoutMs: 100,
      lookupImpl: async () => new Promise(() => undefined),
      preflightImpl: async () => {
        assert.fail("preflight must not run after DNS timeout");
      },
      sessionExchange: async () => {
        assert.fail("Socket.IO must not run after DNS timeout");
      },
    });
    assert.deepEqual(
      await instance.verify(request("http://foundry.internal:30000", ["session=x"])),
      { ok: false, code: "timeout" },
    );
  });

  void it("reports bounded timeout and unavailable failures without error details", async () => {
    const timedOut = verifier({
      sessionExchange: async () => {
        throw new Error("timeout");
      },
    });
    assert.deepEqual(await timedOut.verify(request("http://localhost:30000", ["session=x"])), {
      ok: false,
      code: "timeout",
    });
    const unavailable = verifier({
      sessionExchange: async () => {
        throw new Error("session=x");
      },
    });
    const result = await unavailable.verify(request("http://localhost:30000", ["session=x"]));
    assert.deepEqual(result, { ok: false, code: "unavailable" });
    assert.doesNotMatch(JSON.stringify(result), /session=x/);
  });
});
