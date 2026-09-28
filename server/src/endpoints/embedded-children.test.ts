/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EMBEDDED_CHILD_COMMANDS } from "@foundry-local-api/shared";
import { FoundryBridgeError } from "../bridge/errors.js";
import { DurableIdempotencyStore } from "../foundations/idempotency-store.js";
import { embeddedChildrenEndpointDescriptors } from "./embedded-children.js";
void describe("embedded child descriptors", () => {
  void it("exposes bounded CRUD and routes exact commands", async () => {
    assert.equal(embeddedChildrenEndpointDescriptors.length, 5);
    const calls: any[] = [];
    await embeddedChildrenEndpointDescriptors[0]!.handler(
      { family: "Tile", parentId: "s" },
      {
        foundryClient: {
          call: async (...args: any[]) => {
            calls.push(args);
            return {};
          },
        } as any,
      },
    );
    assert.equal(calls[0][0], EMBEDDED_CHILD_COMMANDS.LIST);
  });

  void it("accepts dry-run mutations without consuming durable idempotency", async () => {
    const descriptor = embeddedChildrenEndpointDescriptors.find(({ name }) =>
      name.endsWith("update_embedded_child"),
    )!;
    const input = {
      family: "RegionBehavior",
      parentId: "region",
      sceneId: "scene",
      childId: "behavior",
      expectedParentRevision: "a".repeat(64),
      expectedChildRevision: "b".repeat(64),
      idempotencyKey: "preview-key",
      dryRun: true,
      changes: { system: { threshold: 2 } },
    };
    assert.equal(descriptor.inputSchema!.safeParse(input).success, true);
    let durableCalls = 0;
    const result = await descriptor.handler(input, {
      foundryClient: { call: async () => ({ dryRun: true, persisted: false }) } as any,
      foundations: {
        idempotency: {
          execute: async () => {
            durableCalls += 1;
            return { replayed: false, result: {} };
          },
        },
      } as any,
    });
    assert.deepEqual(result, { dryRun: true, persisted: false });
    assert.equal(durableCalls, 0);
  });

  void it("requires sceneId for every RegionBehavior operation schema", () => {
    for (const descriptor of embeddedChildrenEndpointDescriptors) {
      const operation = descriptor.name.split("_")[1];
      const mutation = operation === "create" || operation === "update" || operation === "delete";
      const input = {
        family: "RegionBehavior",
        parentId: "region",
        ...(operation === "get" || operation === "update" || operation === "delete"
          ? { childId: "behavior" }
          : {}),
        ...(mutation
          ? {
              expectedParentRevision: "a".repeat(64),
              idempotencyKey: `scene-required-${operation}`,
            }
          : {}),
        ...(operation === "create" ? { data: { _id: "behavior" } } : {}),
        ...(operation === "update" ? { expectedChildRevision: "b".repeat(64), changes: {} } : {}),
        ...(operation === "delete" ? { expectedChildRevision: "b".repeat(64) } : {}),
      };
      assert.equal(descriptor.inputSchema!.safeParse(input).success, false, descriptor.name);
      assert.equal(
        descriptor.inputSchema!.safeParse({ ...input, sceneId: "scene" }).success,
        true,
        descriptor.name,
      );
    }
  });

  void it("clears verified rolled-back durable state so a same-key restart retry is safe", async () => {
    const descriptor = embeddedChildrenEndpointDescriptors.find(({ name }) =>
      name.endsWith("update_embedded_child"),
    )!;
    const input = {
      family: "RegionBehavior",
      parentId: "region",
      sceneId: "scene",
      childId: "behavior",
      expectedParentRevision: "a".repeat(64),
      expectedChildRevision: "b".repeat(64),
      idempotencyKey: "restart-safe-retry",
      changes: { system: { threshold: 2 } },
    };
    const path = join(mkdtempSync(join(tmpdir(), "embedded-idempotency-")), "state.json");
    let calls = 0;
    const foundryClient = {
      call: async () => {
        calls += 1;
        if (calls === 1)
          throw new FoundryBridgeError("INCOMPLETE_RESULT", "post-write verification failed", {
            details: { compensationVerified: true, persistentPartialSuccess: false },
          });
        return { childId: "behavior", persisted: true, replayed: false };
      },
    } as any;
    const firstStore = new DurableIdempotencyStore(path);
    await assert.rejects(
      descriptor.handler(input, {
        foundryClient,
        foundations: { idempotency: firstStore } as any,
      }),
      (error: unknown) => error instanceof FoundryBridgeError && error.code === "INCOMPLETE_RESULT",
    );

    const restartedStore = new DurableIdempotencyStore(path);
    const retried = await descriptor.handler(input, {
      foundryClient,
      foundations: { idempotency: restartedStore } as any,
    });
    assert.equal(calls, 2);
    assert.deepEqual(retried, { childId: "behavior", persisted: true, replayed: false });
  });

  void it("retains pending durable state when rollback proof is absent", async () => {
    const descriptor = embeddedChildrenEndpointDescriptors.find(({ name }) =>
      name.endsWith("update_embedded_child"),
    )!;
    const input = {
      family: "RegionBehavior",
      parentId: "region",
      sceneId: "scene",
      childId: "behavior",
      expectedParentRevision: "a".repeat(64),
      expectedChildRevision: "b".repeat(64),
      idempotencyKey: "unproven-rollback",
      changes: { system: { threshold: 2 } },
    };
    const path = join(mkdtempSync(join(tmpdir(), "embedded-pending-")), "state.json");
    let calls = 0;
    const foundryClient = {
      call: async () => {
        calls += 1;
        throw new FoundryBridgeError("ROLLBACK_FAILED", "restoration was not proven");
      },
    } as any;
    await assert.rejects(
      descriptor.handler(input, {
        foundryClient,
        foundations: { idempotency: new DurableIdempotencyStore(path) } as any,
      }),
    );
    await assert.rejects(
      descriptor.handler(input, {
        foundryClient,
        foundations: { idempotency: new DurableIdempotencyStore(path) } as any,
      }),
      /prior attempt.*did not record a committed result/i,
    );
    assert.equal(calls, 1);
  });

  void it("clears definitely pre-commit failures so corrected retries are not stranded", async () => {
    const descriptor = embeddedChildrenEndpointDescriptors.find(({ name }) =>
      name.endsWith("update_embedded_child"),
    )!;
    const input = {
      family: "RegionBehavior",
      parentId: "region",
      sceneId: "scene",
      childId: "behavior",
      expectedParentRevision: "a".repeat(64),
      expectedChildRevision: "b".repeat(64),
      idempotencyKey: "precommit-retry",
      changes: { system: { threshold: 2 } },
    };
    const path = join(mkdtempSync(join(tmpdir(), "embedded-precommit-")), "state.json");
    let calls = 0;
    const foundryClient = {
      call: async () => {
        calls += 1;
        if (calls === 1) throw new FoundryBridgeError("STALE_REVISION", "stale before commit");
        return { childId: "behavior", persisted: true, replayed: false };
      },
    } as any;
    await assert.rejects(
      descriptor.handler(input, {
        foundryClient,
        foundations: { idempotency: new DurableIdempotencyStore(path) } as any,
      }),
      (error: unknown) => error instanceof FoundryBridgeError && error.code === "STALE_REVISION",
    );

    const retried = await descriptor.handler(input, {
      foundryClient,
      foundations: { idempotency: new DurableIdempotencyStore(path) } as any,
    });
    assert.equal(calls, 2);
    assert.deepEqual(retried, { childId: "behavior", persisted: true, replayed: false });
  });
});
