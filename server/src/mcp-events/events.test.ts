import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { EventService, eventCursor } from "./events.js";
import { McpError } from "./contract.js";
import { FileEventStore } from "./store.js";
import {
  FIXTURE_NOW,
  fixtureFilters,
  fixtureIdentity,
  fixtureOwner,
  fixtureSecret,
  fixtureService,
  fixtureSubscription,
  fixtureEvent,
  fixtureEventId,
  fixtureDefinition,
  type FixtureOptions,
} from "./test-support.js";

void test("security callbacks are mandatory; discovery is explicitly scoped", async () => {
  assert.throws(() => new EventService({} as FixtureOptions));
  const fixture = fixtureService();
  assert.throws(
    () =>
      new EventService({
        ...fixture.options,
        definition: { ...fixtureDefinition, sameScope: undefined },
      } as unknown as FixtureOptions),
  );
  assert.deepEqual(await fixture.service.list(fixtureOwner), []);
  assert.equal((await fixture.service.list(fixtureOwner, fixtureFilters)).length, 1);
  assert.deepEqual(await fixture.service.list("unauthorized", fixtureFilters), []);
});
void test("subscription verifies before persistence and rejects codec plaintext", async () => {
  const fixture = fixtureService({
    webhooks: {
      verify: async () => {
        throw new McpError(-32015, "Synthetic refusal.");
      },
      send: async () => ({ status: 204, body: "" }),
    },
  });
  await assert.rejects(
    fixture.service.subscribe(fixtureOwner, fixtureSubscription(), new AbortController().signal),
  );
  assert.equal(fixture.store.read().subscriptions.length, 0);
  const insecure = fixtureService({ codec: { seal: (value) => value, unseal: (value) => value } });
  await assert.rejects(
    insecure.service.subscribe(fixtureOwner, fixtureSubscription(), new AbortController().signal),
  );
  assert.equal(insecure.store.read().subscriptions.length, 0);
});
void test("canonical filters make refresh idempotent and fresh subscriptions skip historical records", async () => {
  const fixture = fixtureService();
  fixture.service.enqueue(fixtureEvent(), fixtureIdentity);
  const first = await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription(),
    new AbortController().signal,
  );
  const reordered = {
    publisherId: fixtureFilters.publisherId,
    streamId: fixtureFilters.streamId,
    tenantId: fixtureFilters.tenantId,
  };
  const second = await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription({ arguments: reordered }),
    new AbortController().signal,
  );
  assert.equal(first.id, second.id);
  assert.equal(fixture.store.read().subscriptions.length, 1);
  assert.equal(fixture.store.read().deliveries.length, 0);
});
void test("verified publisher ingress deduplicates observers and rejects changed identities and reverse revisions", async () => {
  const fixture = fixtureService();
  await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription(),
    new AbortController().signal,
  );
  const turn = fixtureEvent();
  assert.equal(fixture.service.enqueue(turn, fixtureIdentity).replayed, false);
  assert.equal(
    fixture.service.enqueue(
      { ...turn, timestamp: new Date(FIXTURE_NOW + 1).toISOString() },
      fixtureIdentity,
    ).replayed,
    true,
  );
  assert.equal(fixture.store.read().deliveries.length, 1);
  assert.throws(() =>
    fixture.service.enqueue({ ...turn, eventId: `turn-${"a".repeat(64)}` }, fixtureIdentity),
  );
  assert.throws(() =>
    fixture.service.enqueue(turn, { ...fixtureIdentity, lane: "player" } as never),
  );
  const backwards = { ...turn, previous: turn.next, next: turn.previous };
  backwards.eventId = fixtureEventId(backwards);
  assert.throws(() => fixture.service.enqueue(backwards, fixtureIdentity));
});
void test("webhook receipt is distinct from consumer completion; refresh cannot skip pending work", async () => {
  const fixture = fixtureService();
  await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription(),
    new AbortController().signal,
  );
  const enqueued = fixture.service.enqueue(fixtureEvent(), fixtureIdentity);
  const refreshed = await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription({ cursor: enqueued.cursor }),
    new AbortController().signal,
  );
  assert.notEqual(refreshed.cursor, enqueued.cursor);
  const pass = await fixture.service.dispatchDue(new AbortController().signal);
  assert.deepEqual(pass, { attempted: 1, received: 1, deadLettered: 0 });
  assert.equal(fixture.store.read().deliveries[0]!.status, "received");
  assert.equal(JSON.parse(fixture.requests[0]!.body).name, "fixture.record_updated");
  assert.equal(
    JSON.parse(fixture.requests[0]!.body).data.stateRevision,
    fixtureEvent().stateRevision,
  );
  assert.equal((await fixture.service.dispatchDue(new AbortController().signal)).attempted, 0);
});
void test("bounded retries preserve IDs, order and retry deadline", async () => {
  const fixture = fixtureService({ maxAttempts: 2 });
  await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription(),
    new AbortController().signal,
  );
  fixture.service.enqueue(fixtureEvent(), fixtureIdentity);
  fixture.service.enqueue(fixtureEvent(2), fixtureIdentity);
  fixture.setResponse({ status: 503, body: "" });
  await fixture.service.dispatchDue(new AbortController().signal);
  assert.equal(fixture.requests.length, 1);
  assert.equal((await fixture.service.dispatchDue(new AbortController().signal)).attempted, 0);
  fixture.setNow(FIXTURE_NOW + 1000);
  assert.equal((await fixture.service.dispatchDue(new AbortController().signal)).deadLettered, 1);
  assert.equal(fixture.requests[0]!.eventId, fixture.requests[1]!.eventId);
  fixture.setResponse({ status: 204, body: "" });
  assert.equal((await fixture.service.dispatchDue(new AbortController().signal)).received, 1);
});
void test("410 stops the callback, 413 is terminal, and redirects are never retried", async () => {
  for (const status of [410, 413, 302]) {
    const fixture = fixtureService();
    await fixture.service.subscribe(
      fixtureOwner,
      fixtureSubscription(),
      new AbortController().signal,
    );
    fixture.service.enqueue(fixtureEvent(), fixtureIdentity);
    fixture.setResponse({ status, body: "" });
    assert.equal((await fixture.service.dispatchDue(new AbortController().signal)).deadLettered, 1);
    assert.equal((await fixture.service.dispatchDue(new AbortController().signal)).attempted, 0);
    if (status === 410) assert.equal(fixture.store.read().subscriptions[0]!.status, "stopped");
  }
});
void test("revocation and expiry stop delivery without contacting a callback", async () => {
  for (const expire of [true, false]) {
    const fixture = fixtureService();
    await fixture.service.subscribe(
      fixtureOwner,
      fixtureSubscription({ ttlMs: 1000 }),
      new AbortController().signal,
    );
    fixture.service.enqueue(fixtureEvent(), fixtureIdentity);
    if (expire) fixture.setNow(FIXTURE_NOW + 1001);
    else fixture.setAuthorized(false);
    assert.equal((await fixture.service.dispatchDue(new AbortController().signal)).attempted, 0);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.store.read().deliveries[0]!.status, "cancelled");
  }
});
void test("unsubscribe aborts in-flight delivery and a late acknowledgement cannot revive it", async () => {
  let started!: () => void;
  const sending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const finishing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let aborted = false;
  const fixture = fixtureService({
    webhooks: {
      verify: async () => {},
      send: async (_request, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        started();
        await finishing;
        return { status: 204, body: "" };
      },
    },
  });
  await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription(),
    new AbortController().signal,
  );
  fixture.service.enqueue(fixtureEvent(), fixtureIdentity);
  const dispatch = fixture.service.dispatchDue(new AbortController().signal);
  await sending;
  const { secret: _secret, ...delivery } = fixtureSubscription().delivery;
  await fixture.service.unsubscribe(fixtureOwner, {
    name: "fixture.record_updated",
    arguments: fixtureFilters,
    delivery,
  });
  finish();
  await dispatch;
  assert.equal(aborted, true);
  assert.equal(fixture.store.read().deliveries[0]!.status, "cancelled");
});

void test("unsubscribe during awaited authorization cannot claim or send a cancelled delivery", async () => {
  let pause = false;
  let started!: () => void;
  const authorizing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const finishing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fixture = fixtureService({
    authorizeSubscription: async () => {
      if (pause) {
        started();
        await finishing;
      }
      return true;
    },
  });
  await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription(),
    new AbortController().signal,
  );
  fixture.service.enqueue(fixtureEvent(), fixtureIdentity);
  pause = true;
  const dispatch = fixture.service.dispatchDue(new AbortController().signal);
  await authorizing;
  const { secret: _secret, ...delivery } = fixtureSubscription().delivery;
  await fixture.service.unsubscribe(fixtureOwner, {
    name: "fixture.record_updated",
    arguments: fixtureFilters,
    delivery,
  });
  finish();
  assert.equal((await dispatch).attempted, 0);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.store.read().deliveries[0]!.status, "cancelled");
  assert.equal(fixture.store.read().deliveries[0]!.attempts, 0);
});

void test("expiry during awaited delivery authorization cannot claim or send", async () => {
  let pause = false;
  let started!: () => void;
  const authorizing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const finishing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fixture = fixtureService({
    canDeliver: async () => {
      if (pause) {
        started();
        await finishing;
      }
      return true;
    },
  });
  await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription({ ttlMs: 1000 }),
    new AbortController().signal,
  );
  fixture.service.enqueue(fixtureEvent(), fixtureIdentity);
  pause = true;
  const dispatch = fixture.service.dispatchDue(new AbortController().signal);
  await authorizing;
  fixture.setNow(FIXTURE_NOW + 1001);
  finish();
  assert.equal((await dispatch).attempted, 0);
  assert.equal(fixture.requests.length, 0);
});

void test("stopped and expired identities do not consume active capacity; retained history stays bounded", async () => {
  const fixture = fixtureService();
  const signal = new AbortController().signal;
  for (let index = 0; index < 70; index++) {
    const input = fixtureSubscription({
      delivery: {
        ...fixtureSubscription().delivery,
        url: `https://callback.example.com/fixture-${index}`,
      },
    });
    await fixture.service.subscribe(fixtureOwner, input, signal);
    const { secret: _secret, ...delivery } = input.delivery;
    await fixture.service.unsubscribe(fixtureOwner, {
      name: input.name,
      arguments: input.arguments,
      delivery,
    });
  }
  assert.equal(fixture.store.read().subscriptions.length, 64);
  for (let index = 0; index < 8; index++)
    await fixture.service.subscribe(
      fixtureOwner,
      fixtureSubscription({
        delivery: {
          ...fixtureSubscription().delivery,
          url: `https://callback.example.com/active-${index}`,
        },
        ttlMs: 1000,
      }),
      signal,
    );
  await assert.rejects(fixture.service.subscribe(fixtureOwner, fixtureSubscription(), signal));
  fixture.setNow(FIXTURE_NOW + 1001);
  await fixture.service.subscribe(fixtureOwner, fixtureSubscription(), signal);
  assert.equal(
    fixture.store.read().subscriptions.filter((item) => item.status === "active").length,
    1,
  );
  assert.equal(fixture.store.read().subscriptions.length, 64);
});

void test("callback verification cache has a fixed lifetime, principal isolation and safe key rotation", async () => {
  let verifications = 0;
  const fixture = fixtureService({
    authorizeSubscription: () => true,
    webhooks: {
      verify: async () => {
        verifications++;
      },
      send: async () => ({ status: 204, body: "" }),
    },
  });
  const signal = new AbortController().signal;
  await fixture.service.subscribe(fixtureOwner, fixtureSubscription(), signal);
  await fixture.service.subscribe(fixtureOwner, fixtureSubscription(), signal);
  assert.equal(verifications, 1);
  fixture.setNow(FIXTURE_NOW + 299999);
  await fixture.service.subscribe(fixtureOwner, fixtureSubscription(), signal);
  assert.equal(verifications, 1);
  fixture.setNow(FIXTURE_NOW + 300000);
  await fixture.service.subscribe(fixtureOwner, fixtureSubscription(), signal);
  assert.equal(verifications, 2);
  await fixture.service.subscribe("other-principal", fixtureSubscription(), signal);
  assert.equal(verifications, 3);
  const replacement = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
  const rotated = fixtureSubscription({
    delivery: { ...fixtureSubscription().delivery, secret: replacement },
  });
  await fixture.service.subscribe(fixtureOwner, rotated, signal);
  assert.equal(verifications, 4);
  await fixture.service.subscribe(fixtureOwner, rotated, signal);
  assert.equal(verifications, 4);
});
void test("stop cancels callback verification so a delayed subscribe cannot restore delivery", async () => {
  let started!: () => void;
  const verifying = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const finishing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fixture = fixtureService({
    webhooks: {
      verify: async () => {
        started();
        await finishing;
      },
      send: async () => ({ status: 204, body: "" }),
    },
  });
  const pending = fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription(),
    new AbortController().signal,
  );
  await verifying;
  fixture.service.stopScope(fixtureFilters);
  finish();
  await assert.rejects(pending);
  assert.equal(fixture.store.read().subscriptions.length, 0);
});

void test("unsubscribe overtaking initial authorization cancels both creation and refresh", async () => {
  for (const refresh of [false, true]) {
    let pause = false;
    let verifications = 0;
    let started!: () => void;
    const authorizing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const finishing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fixture = fixtureService({
      authorizeSubscription: async () => {
        if (pause) {
          started();
          await finishing;
        }
        return true;
      },
      webhooks: {
        verify: async () => {
          verifications++;
        },
        send: async () => ({ status: 204, body: "" }),
      },
    });
    if (refresh)
      await fixture.service.subscribe(
        fixtureOwner,
        fixtureSubscription(),
        new AbortController().signal,
      );
    const previousVerifications = verifications;
    pause = true;
    const pending = fixture.service.subscribe(
      fixtureOwner,
      fixtureSubscription(),
      new AbortController().signal,
    );
    await authorizing;
    const { secret: _secret, ...delivery } = fixtureSubscription().delivery;
    await fixture.service.unsubscribe(fixtureOwner, {
      name: "fixture.record_updated",
      arguments: fixtureFilters,
      delivery,
    });
    finish();
    await assert.rejects(pending, (error) => error instanceof McpError && error.code === -32003);
    assert.equal(
      fixture.store.read().subscriptions.filter((item) => item.status === "active").length,
      0,
    );
    assert.equal(verifications, previousVerifications);
    // A later explicit subscription remains permitted; only overtaken requests fail.
    pause = false;
    await fixture.service.subscribe(
      fixtureOwner,
      fixtureSubscription(),
      new AbortController().signal,
    );
    assert.equal(
      fixture.store.read().subscriptions.filter((item) => item.status === "active").length,
      1,
    );
  }
});

void test("unsubscribe also cancels older subscribe requests waiting in the service queue", async () => {
  let verifications = 0;
  let started!: () => void;
  const verifying = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const finishing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fixture = fixtureService({
    webhooks: {
      verify: async () => {
        verifications++;
        started();
        await finishing;
      },
      send: async () => ({ status: 204, body: "" }),
    },
  });
  const signal = new AbortController().signal;
  const first = fixture.service.subscribe(fixtureOwner, fixtureSubscription(), signal);
  await verifying;
  const queued = fixture.service.subscribe(fixtureOwner, fixtureSubscription(), signal);
  const { secret: _secret, ...delivery } = fixtureSubscription().delivery;
  await fixture.service.unsubscribe(fixtureOwner, {
    name: "fixture.record_updated",
    arguments: fixtureFilters,
    delivery,
  });
  const rejected = Promise.all([assert.rejects(first), assert.rejects(queued)]);
  finish();
  await rejected;
  assert.equal(fixture.store.read().subscriptions.length, 0);
  assert.equal(verifications, 1);
});
void test("secret refresh uses a bounded dual-signature rotation window", async () => {
  const fixture = fixtureService();
  await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription(),
    new AbortController().signal,
  );
  const replacement = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
  await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription({ delivery: { ...fixtureSubscription().delivery, secret: replacement } }),
    new AbortController().signal,
  );
  fixture.service.enqueue(fixtureEvent(), fixtureIdentity);
  await fixture.service.dispatchDue(new AbortController().signal);
  assert.equal(fixture.requests[0]!.previousSecret, fixtureSecret);
  fixture.setNow(FIXTURE_NOW + 60001);
  fixture.service.enqueue(fixtureEvent(2), fixtureIdentity);
  await fixture.service.dispatchDue(new AbortController().signal);
  assert.equal(fixture.requests[1]!.previousSecret, undefined);
});
void test("queue capacity refuses pending loss and explicit old cursors report truncation", async () => {
  const fixture = fixtureService({ maxEvents: 1 });
  const initial = eventCursor(fixture.store.read(), 0);
  await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription(),
    new AbortController().signal,
  );
  fixture.service.enqueue(fixtureEvent(), fixtureIdentity);
  assert.throws(() => fixture.service.enqueue(fixtureEvent(2), fixtureIdentity));
  await fixture.service.dispatchDue(new AbortController().signal);
  fixture.service.enqueue(fixtureEvent(2), fixtureIdentity);
  const replay = await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription({ cursor: initial }),
    new AbortController().signal,
  );
  assert.equal(replay.truncated, true);
});
void test("private durable store preserves subscriptions, pending deliveries and cursors across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-events-fixture-"));
  const path = join(root, "events.json");
  const privateFixture = (value: string) => {
    assert.ok(!relative(root, value).startsWith(".."));
  };
  try {
    const store = new FileEventStore(path, privateFixture, fixtureDefinition);
    const first = fixtureService({ store });
    const subscription = await first.service.subscribe(
      fixtureOwner,
      fixtureSubscription(),
      new AbortController().signal,
    );
    const event = first.service.enqueue(fixtureEvent(), fixtureIdentity);
    assert.ok(!readFileSync(path, "utf8").includes(fixtureSecret));
    const reopened = new FileEventStore(path, privateFixture, fixtureDefinition);
    const second = fixtureService({ store: reopened });
    assert.equal(reopened.read().subscriptions[0]!.id, subscription.id);
    assert.equal(eventCursor(reopened.read(), 1), event.cursor);
    assert.equal((await second.service.dispatchDue(new AbortController().signal)).received, 1);
    assert.throws(() =>
      store.transact((state) => {
        state.nextSequence++;
      }),
    );
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), "foundry-events-fixture-")));
    rmSync(root, { recursive: true });
  }
});

void test("saved cursor replays an expiry-cancelled delivery once after durable store restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-events-fixture-"));
  const path = join(root, "expiry-events.json");
  const privateFixture = (value: string) => {
    assert.ok(!relative(root, value).startsWith(".."));
  };
  const signal = new AbortController().signal;
  try {
    const firstStore = new FileEventStore(path, privateFixture, fixtureDefinition);
    const first = fixtureService({ store: firstStore });
    const subscription = await first.service.subscribe(
      fixtureOwner,
      fixtureSubscription({ ttlMs: 1000 }),
      signal,
    );
    const event = first.service.enqueue(fixtureEvent(), fixtureIdentity);
    first.setNow(FIXTURE_NOW + 1001);
    assert.equal((await first.service.dispatchDue(signal)).attempted, 0);
    assert.equal(firstStore.read().deliveries[0]!.lastReason, "expired");
    const reopened = new FileEventStore(path, privateFixture, fixtureDefinition);
    const second = fixtureService({ store: reopened });
    second.setNow(FIXTURE_NOW + 1001);
    const refresh = await second.service.subscribe(
      fixtureOwner,
      fixtureSubscription({ cursor: subscription.cursor }),
      signal,
    );
    assert.equal(refresh.id, subscription.id);
    assert.equal(refresh.truncated, false);
    assert.deepEqual(await second.service.dispatchDue(signal), {
      attempted: 1,
      received: 1,
      deadLettered: 0,
    });
    assert.equal(second.requests.length, 1);
    assert.equal(second.requests[0]!.eventId, event.eventId);
    assert.equal((await second.service.dispatchDue(signal)).attempted, 0);
    // An older saved cursor must not replay an acknowledged delivery after another restart.
    const third = fixtureService({
      store: new FileEventStore(path, privateFixture, fixtureDefinition),
    });
    third.setNow(FIXTURE_NOW + 1001);
    await third.service.subscribe(
      fixtureOwner,
      fixtureSubscription({ cursor: subscription.cursor }),
      signal,
    );
    assert.equal((await third.service.dispatchDue(signal)).attempted, 0);
    assert.equal(third.requests.length, 0);
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), "foundry-events-fixture-")));
    rmSync(root, { recursive: true });
  }
});

void test("refresh at expiry replays pending delivery from an explicit saved cursor", async () => {
  const fixture = fixtureService();
  const signal = new AbortController().signal;
  const subscription = await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription({ ttlMs: 1000 }),
    signal,
  );
  fixture.service.enqueue(fixtureEvent(), fixtureIdentity);
  fixture.setNow(FIXTURE_NOW + 1001);
  const refresh = await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription({ cursor: subscription.cursor }),
    signal,
  );
  assert.equal(refresh.cursor, subscription.cursor);
  assert.equal((await fixture.service.dispatchDue(signal)).received, 1);
});

void test("explicit unsubscribe and operator stop remain terminal before and after expiry", async () => {
  for (const expiredFirst of [false, true]) {
    for (const reason of ["unsubscribed", "operator_stop"]) {
      const fixture = fixtureService();
      const signal = new AbortController().signal;
      const subscription = await fixture.service.subscribe(
        fixtureOwner,
        fixtureSubscription({ ttlMs: 1000 }),
        signal,
      );
      fixture.service.enqueue(fixtureEvent(), fixtureIdentity);
      if (expiredFirst) {
        fixture.setNow(FIXTURE_NOW + 1001);
        await fixture.service.dispatchDue(signal);
      }
      if (reason === "operator_stop") fixture.service.stopScope(fixtureFilters);
      else {
        const { secret: _secret, ...delivery } = fixtureSubscription().delivery;
        await fixture.service.unsubscribe(fixtureOwner, {
          name: "fixture.record_updated",
          arguments: fixtureFilters,
          delivery,
        });
      }
      await fixture.service.subscribe(
        fixtureOwner,
        fixtureSubscription({ cursor: subscription.cursor }),
        signal,
      );
      assert.equal((await fixture.service.dispatchDue(signal)).attempted, 0);
      assert.equal(fixture.requests.length, 0);
      assert.equal(fixture.store.read().deliveries[0]!.status, "cancelled");
      assert.equal(fixture.store.read().deliveries[0]!.lastReason, reason);
    }
  }
});

void test("expiry replay preserves retry deadlines, prior attempts and terminal retry budgets", async () => {
  const fixture = fixtureService({ maxAttempts: 3 });
  const signal = new AbortController().signal;
  const subscription = await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription({ ttlMs: 2500 }),
    signal,
  );
  fixture.service.enqueue(fixtureEvent(), fixtureIdentity);
  fixture.setResponse({ status: 503, body: "" });
  await fixture.service.dispatchDue(signal);
  fixture.setNow(FIXTURE_NOW + 1000);
  await fixture.service.dispatchDue(signal);
  fixture.setNow(FIXTURE_NOW + 2501);
  await fixture.service.dispatchDue(signal);
  await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription({ cursor: subscription.cursor }),
    signal,
  );
  assert.equal((await fixture.service.dispatchDue(signal)).attempted, 0);
  fixture.setNow(FIXTURE_NOW + 3000);
  assert.equal((await fixture.service.dispatchDue(signal)).deadLettered, 1);
  assert.equal(fixture.store.read().deliveries[0]!.attempts, 3);
  assert.equal(fixture.requests.length, 3);
  await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription({ cursor: subscription.cursor }),
    signal,
  );
  assert.equal((await fixture.service.dispatchDue(signal)).attempted, 0);
});
