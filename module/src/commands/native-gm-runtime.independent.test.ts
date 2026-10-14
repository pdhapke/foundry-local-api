import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeNative,
  nativeActor,
  readNativeReceipt,
  runNativeMutation,
} from "./native-gm-runtime.js";
import { inspectGmReceipt } from "./gm-receipts.js";
import type { NativeGmApplyInput } from "@foundry-local-api/shared";

const MODULE = "foundry-local-api";
class ReviewDoc {
  actor?: ReviewDoc;
  children = new Map<string, ReviewDoc>();
  updates = 0;
  onUpdate?: () => void;
  constructor(
    readonly id: string,
    readonly data: Record<string, any>,
  ) {}
  toObject() {
    return structuredClone(this.data);
  }
  getEmbeddedCollection() {
    return this.children;
  }
  async update(changes: Record<string, unknown>) {
    this.updates++;
    for (const [path, value] of Object.entries(changes)) {
      const parts = path.split(".");
      let target = this.data;
      for (const part of parts.slice(0, -1)) target = target[part] ??= {};
      target[parts.at(-1)!] = structuredClone(value);
    }
    this.onUpdate?.();
    return this;
  }
}
function fixture(entries: Record<string, unknown> = {}) {
  const gm = { id: "gm", isGM: true, active: true };
  const ledger = new ReviewDoc("receipts", {
    ownership: { default: 0 },
    flags: { [MODULE]: { nativeGmVersion: "gm-actions-v1", nativeGmReceipts: entries } },
  });
  const scene = new ReviewDoc("s", { active: true });
  const token = new ReviewDoc("t", {});
  token.actor = new ReviewDoc("a", {});
  scene.children.set("t", token);
  const world = {
    world: { id: "w" },
    user: gm,
    users: new Map([
      ["gm", gm],
      ["player", { id: "player", isGM: false, active: true }],
    ]),
    release: { version: "14.368" },
    system: { id: "dnd5e", version: "6.0.3" },
    collections: new Map([
      ["Scene", new Map([["s", scene]])],
      ["JournalEntry", new Map([["receipts", ledger]])],
    ]),
  };
  Object.assign(globalThis, { game: world, canvas: { scene }, CONFIG: {} });
  const input: NativeGmApplyInput = {
    schemaVersion: "gm-actions-v1",
    worldId: "w",
    userId: "gm",
    sceneId: "s",
    action: { kind: "review" },
    expectedState: { resource: 1 },
    idempotencyKey: "intent",
    correlationId: "trace",
  };
  return { world, ledger, scene, token, input };
}
void test("independent: native identity and token actor binding reject spoofing", () => {
  const { input } = fixture();
  assert.throws(() => authorizeNative({ ...input, userId: "player" }), /GM/);
  assert.throws(() => authorizeNative({ ...input, worldId: "other" }), /GM/);
  assert.throws(() => nativeActor(input, "t", "other"), /binding/);
});
void test("independent: exact receipt replay never calls native effect twice", async () => {
  const { input } = fixture();
  let resource = 1,
    effects = 0;
  const read = () => ({ resource });
  const apply = async () => {
    effects++;
    resource--;
    return { ok: true };
  };
  const first = await runNativeMutation(input, read, apply);
  const second = await runNativeMutation(input, read, apply);
  assert.equal(first.outcome, "confirmed");
  assert.deepEqual(second, first);
  assert.equal(effects, 1);
  await assert.rejects(
    runNativeMutation({ ...input, correlationId: "retry" }, read, apply),
    /reused/,
  );
});
void test("independent: native recipe reservation admits once concurrently and preserves evidence after restart", async () => {
  const { input, world } = fixture();
  input.action = {
    kind: "recipe.reservation",
    recipeId: "native-document-preparation",
    requestFingerprint: "a".repeat(64),
  };
  let admits = 0;
  const apply = async () => {
    admits++;
    return { reservationOnly: true };
  };
  const read = () => input.expectedState;
  const results = await Promise.all([
    runNativeMutation(input, read, apply),
    runNativeMutation(input, read, apply),
  ]);
  const first = results.find((r) => r.outcome === "confirmed")!;
  assert.ok(first);
  assert.equal(
    results.filter(
      (r) =>
        r.outcome === "failure" &&
        (r.data as Record<string, unknown>).reservationAlreadyExists === true,
    ).length,
    1,
  );
  assert.equal(admits, 1);
  Object.assign(globalThis, { game: { ...world } });
  const restarted = await runNativeMutation(input, read, apply);
  assert.equal(restarted.outcome, "failure");
  assert.equal((restarted.data as Record<string, unknown>).reservationAlreadyExists, true);
  assert.equal(admits, 1);
  assert.deepEqual(await readNativeReceipt(input, input.idempotencyKey), first);
});
void test("independent: prototype key cannot bypass durable reservation", async () => {
  const { input, ledger } = fixture();
  let effects = 0;
  const unsafe = { ...input, idempotencyKey: "__proto__" };
  try {
    await runNativeMutation(
      unsafe,
      () => ({ resource: 1 }),
      async () => {
        effects++;
      },
    );
  } catch {
    assert.equal(effects, 0);
    return;
  }
  assert.ok(
    Object.hasOwn(ledger.data.flags[MODULE].nativeGmReceipts, "__proto__"),
    "effect dispatched without own durable reservation",
  );
  await runNativeMutation(
    unsafe,
    () => ({ resource: 1 }),
    async () => {
      effects++;
    },
  );
  assert.equal(effects, 1);
});
void test("independent: persisted reservation fences a new key after restart", async () => {
  const { input } = fixture({ prior: { fingerprint: "prior", status: "reserved" } });
  let effects = 0;
  await assert.rejects(
    runNativeMutation(
      input,
      () => ({ resource: 1 }),
      async () => {
        effects++;
      },
    ),
    /uncertain/,
  );
  assert.equal(effects, 0);
});
void test("independent: stale state refuses effects before reservation", async () => {
  const { input, ledger } = fixture();
  let effects = 0;
  await assert.rejects(
    runNativeMutation(
      input,
      () => ({ resource: 0 }),
      async () => {
        effects++;
      },
    ),
    /state changed/,
  );
  assert.equal(effects, 0);
  assert.equal(ledger.updates, 0);
});
void test("independent: scene switch during receipt save retains fence and never dispatches", async () => {
  const { input, ledger } = fixture();
  let effects = 0;
  ledger.onUpdate = () => {
    (globalThis as any).canvas.scene = { id: "other" };
  };
  await assert.rejects(
    runNativeMutation(
      input,
      () => ({ resource: 1 }),
      async () => {
        effects++;
      },
    ),
    /scene/,
  );
  assert.equal(effects, 0);
  assert.equal(ledger.data.flags[MODULE].nativeGmReceipts.intent.status, "reserved");
});
void test("independent: corrupt or player-readable journals refuse native effects", async () => {
  let setup = fixture({ corrupt: { fingerprint: "x", status: "terminal" } });
  await assert.rejects(
    runNativeMutation(
      setup.input,
      () => ({ resource: 1 }),
      async () => {},
    ),
    /invalid/,
  );
  setup = fixture();
  setup.ledger.data.ownership.player = 2;
  await assert.rejects(
    runNativeMutation(
      setup.input,
      () => ({ resource: 1 }),
      async () => {},
    ),
    /privacy/,
  );
});
void test("independent: terminal receipt provenance corruption never confirms replay", async () => {
  const { input, ledger } = fixture();
  await runNativeMutation(
    input,
    () => ({ resource: 1 }),
    async () => ({ ok: true }),
  );
  ledger.data.flags[MODULE].nativeGmReceipts.intent.receipt.sceneId = "another-scene";
  await assert.rejects(
    runNativeMutation(
      input,
      () => ({ resource: 1 }),
      async () => {
        throw Error("must not dispatch");
      },
    ),
    /receipt|scope|invalid/i,
  );
});
void test("independent: native veto/cancellation is durable uncertain across game replacement", async () => {
  const { input, ledger } = fixture();
  let effects = 0;
  const result = await runNativeMutation(
    input,
    () => ({ resource: 1 }),
    async () => {
      effects++;
      throw Error("cancelled after possible effect");
    },
  );
  assert.equal(result.outcome, "uncertain");
  const restarted = fixture(ledger.data.flags[MODULE].nativeGmReceipts);
  await assert.rejects(
    runNativeMutation(
      { ...restarted.input, idempotencyKey: "new-key" },
      () => ({ resource: 1 }),
      async () => {
        effects++;
      },
    ),
    /uncertain/,
  );
  assert.equal(effects, 1);
});
void test("independent: reservation acknowledgement failure never dispatches gameplay", async () => {
  const { input, ledger } = fixture();
  let effects = 0;
  ledger.update = async () => ledger;
  await assert.rejects(
    runNativeMutation(
      input,
      () => ({ resource: 1 }),
      async () => {
        effects++;
      },
    ),
    /acknowledgement/,
  );
  assert.equal(effects, 0);
});
void test("independent: safe preflight refusal creates no reservation and permits valid intent", async () => {
  const { input, ledger } = fixture();
  let effects = 0;
  const refused = await runNativeMutation(
    input,
    () => ({ resource: 1 }),
    async () => {
      effects++;
    },
    () => {
      throw Error("human choice missing");
    },
  );
  assert.equal(refused.outcome, "failure");
  assert.equal(ledger.updates, 0);
  assert.equal(
    (
      await runNativeMutation(
        { ...input, idempotencyKey: "valid" },
        () => ({ resource: 1 }),
        async () => {
          effects++;
        },
      )
    ).outcome,
    "confirmed",
  );
  assert.equal(effects, 1);
});
void test("independent: read-only receipt lookup remains available behind uncertainty fence", async () => {
  const { input } = fixture();
  await runNativeMutation(
    input,
    () => ({ resource: 1 }),
    async () => {
      throw Error("acknowledgement lost");
    },
  );
  const result = inspectGmReceipt({
    ...input,
    action: { kind: "receipt", idempotencyKey: input.idempotencyKey },
  });
  assert.equal(result.status, "terminal");
  assert.equal((result.receipt as any).outcome, "uncertain");
  const again = await runNativeMutation(
    input,
    () => ({ resource: 1 }),
    async () => {
      throw Error("must not dispatch");
    },
  );
  assert.equal(again.outcome, "uncertain");
});
void test("independent: receipt inspection rejects tampered action/schema/correlation evidence", async () => {
  for (const field of ["action", "schemaVersion", "correlationId"]) {
    const { input, ledger } = fixture();
    await runNativeMutation(
      input,
      () => ({ resource: 1 }),
      async () => ({ ok: true }),
    );
    const receipt = ledger.data.flags[MODULE].nativeGmReceipts.intent.receipt;
    receipt[field] = field === "action" ? { kind: "forged" } : "forged";
    assert.throws(
      () => inspectGmReceipt({ ...input, action: { kind: "receipt", idempotencyKey: "intent" } }),
      /invalid|corrupt|evidence|scope/i,
    );
    await assert.rejects(readNativeReceipt(input, "intent"), /invalid|corrupt|evidence|scope/i);
  }
});
