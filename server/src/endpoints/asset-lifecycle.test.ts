import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAssetLifecycleEndpointDescriptors } from "./asset-lifecycle.js";
void describe("asset endpoint descriptors", () => {
  void it("exposes stat, move, delete with destructive metadata", () => {
    const descriptors = createAssetLifecycleEndpointDescriptors({} as any);
    assert.deepEqual(
      descriptors.map((x) => x.name),
      ["foundry_stat_asset", "foundry_move_asset", "foundry_delete_asset"],
    );
    assert.equal(descriptors[2]!.annotations?.destructiveHint, true);
    const moveSchema = descriptors[1]!.inputSchema!;
    assert.equal(
      moveSchema.safeParse({
        source: { root: "data", path: "campaign/a.png" },
        destination: { root: "data", path: "campaign/b.png" },
        expectedHash: "a".repeat(64),
        collisionPolicy: "fail",
        ownership: { scope: "campaign", ownershipToken: "must-not-be-public" },
      }).success,
      false,
    );
  });
  void it("recovers a move replay when the fixture registry already records the destination", async () => {
    const input = {
      source: { root: "data", path: "fixtures/test-run/a.png" },
      destination: { root: "data", path: "fixtures/test-run/b.png" },
      expectedHash: "a".repeat(64),
      collisionPolicy: "fail" as const,
      ownership: { scope: "fixture" as const, testRunId: "test-run" },
    };
    let moveFileCalls = 0;
    const service = {
      move: async () => ({
        source: input.source,
        target: input.destination,
        sha256: input.expectedHash,
        alreadyAbsent: true,
        references: [],
      }),
    };
    const descriptors = createAssetLifecycleEndpointDescriptors(service as any);
    const foundryClient = foundryHarness({
      path: input.source.path,
      references: [],
      complete: true,
      warnings: [],
    });
    const foundations = {
      fixtures: {
        get: () => ({ files: [{ ...input.destination, sha256: input.expectedHash }] }),
        moveFile: () => {
          moveFileCalls += 1;
        },
      },
    };
    const result = await descriptors[1]!.handler(input, {
      foundryClient: foundryClient as any,
      foundations: foundations as any,
    });
    assert.equal(result.alreadyAbsent, true);
    assert.equal(moveFileCalls, 0);
  });
  void it("repairs a source-recorded fixture registry after a physical move replay", async () => {
    const input = {
      source: { root: "data", path: "fixtures/test-run/a.png" },
      destination: { root: "data", path: "fixtures/test-run/b.png" },
      expectedHash: "b".repeat(64),
      collisionPolicy: "fail" as const,
      ownership: { scope: "fixture" as const, testRunId: "test-run" },
    };
    let movedTo: unknown;
    const service = {
      move: async () => ({
        source: input.source,
        target: input.destination,
        sha256: input.expectedHash,
        alreadyAbsent: true,
        references: [],
      }),
    };
    const descriptors = createAssetLifecycleEndpointDescriptors(service as any);
    const foundryClient = foundryHarness({
      path: input.source.path,
      references: [],
      complete: true,
      warnings: [],
    });
    const foundations = {
      fixtures: {
        get: () => ({ files: [{ ...input.source, sha256: input.expectedHash }] }),
        moveFile: (_run: string, _source: unknown, target: unknown) => {
          movedTo = target;
        },
      },
    };
    await descriptors[1]!.handler(input, {
      foundryClient: foundryClient as any,
      foundations: foundations as any,
    });
    assert.deepEqual(movedTo, { ...input.destination, sha256: input.expectedHash });
  });
  void it("allows an absent delete replay for an existing run and repairs its registry", async () => {
    const input = {
      root: "data",
      path: "fixtures/test-run/deleted.png",
      expectedHash: "c".repeat(64),
      ownership: { scope: "fixture" as const, testRunId: "test-run" },
      requireUnreferenced: true as const,
    };
    let removed = false;
    const service = {
      inspect: async () => ({ root: input.root, path: input.path, exists: false }),
      delete: async () => ({
        target: { root: input.root, path: input.path },
        sha256: input.expectedHash,
        alreadyAbsent: true,
        references: [],
      }),
    };
    const descriptors = createAssetLifecycleEndpointDescriptors(service as any);
    const foundryClient = foundryHarness({
      path: input.path,
      references: [],
      complete: true,
      warnings: [],
    });
    const foundations = {
      fixtures: {
        get: () => ({ files: [] }),
        removeFile: () => {
          removed = true;
        },
      },
    };
    const result = await descriptors[2]!.handler(input, {
      foundryClient: foundryClient as any,
      foundations: foundations as any,
    });
    assert.equal(result.alreadyAbsent, true);
    assert.equal(removed, true);
  });
});

function foundryHarness(referenceResult: unknown) {
  return {
    getCapabilityReport: () => ({
      clients: [
        {
          lane: "gm",
          isGM: true,
          optedIn: true,
          userId: "gm-user",
          clientId: "gm-client",
        },
      ],
    }),
    call: async () => referenceResult,
    recordAudit: async () => {},
  };
}
