// Phase 32 — unit tests for IntegrationManager, the detection/diffing brain.
// Uses a fake FoundryClient shaped like `{ call: (type) => Promise<unknown> }`
// returning canned SystemInfo/ModuleInfo[] keyed by which META_COMMANDS value
// was requested — the same "fake collaborator" spirit as every other test
// file's fake FoundryClient (e.g. server/src/endpoints/meta.test.ts). No
// Express/MCP is involved.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { META_COMMANDS, type ModuleInfo, type SystemInfo } from "@foundry-local-api/shared";

import type { FoundryClient } from "../bridge/foundry-client.js";
import { IntegrationManager } from "./manager.js";
import type { Integration } from "./types.js";

function fakeClient(system: SystemInfo, modules: ModuleInfo[]): FoundryClient {
  return {
    call: (type: string) => {
      if (type === META_COMMANDS.SYSTEM) {
        return Promise.resolve(system);
      }
      if (type === META_COMMANDS.MODULES) {
        return Promise.resolve(modules);
      }
      throw new Error(`unexpected call type in test: ${type}`);
    },
  } as unknown as FoundryClient;
}

function makeIntegration(
  overrides: Partial<Integration> & Pick<Integration, "id" | "kind">,
): Integration {
  return {
    detect: () => false,
    endpoints: [],
    ...overrides,
  };
}

const SYSTEM: SystemInfo = { id: "dnd5e", title: "D&D 5E", version: "3.3.1" };
const MODULES: ModuleInfo[] = [
  { id: "some-module", title: "Some Module", active: true, version: "1.2.0" },
  { id: "inactive-module", title: "Inactive Module", active: false, version: "1.0.0" },
];

void describe("IntegrationManager", () => {
  void it("stays empty and is a no-op when there are no registered integrations", async () => {
    const manager = new IntegrationManager(fakeClient(SYSTEM, MODULES), []);
    assert.deepEqual(manager.getActive(), []);

    let calls = 0;
    manager.onChange(() => calls++);
    await manager.refresh();

    assert.deepEqual(manager.getActive(), []);
    assert.equal(calls, 0);
  });

  void it("activates a kind:'system' integration whose detect() matches the active system id", async () => {
    const dnd5e = makeIntegration({
      id: "dnd5e",
      kind: "system",
      detect: (systemId) => systemId === "dnd5e",
    });
    const manager = new IntegrationManager(fakeClient(SYSTEM, MODULES), [dnd5e]);

    await manager.refresh();

    assert.deepEqual(
      manager.getActive().map((i) => i.id),
      ["dnd5e"],
    );
  });

  void it("activates a kind:'module' integration matching an active module id", async () => {
    const moduleIntegration = makeIntegration({
      id: "some-module",
      kind: "module",
      detect: (_systemId, moduleIds) => moduleIds.includes("some-module"),
    });
    const manager = new IntegrationManager(fakeClient(SYSTEM, MODULES), [moduleIntegration]);

    await manager.refresh();

    assert.deepEqual(
      manager.getActive().map((i) => i.id),
      ["some-module"],
    );
  });

  void it("does not activate a kind:'module' integration when the module is present but inactive", async () => {
    const moduleIntegration = makeIntegration({
      id: "inactive-module",
      kind: "module",
      detect: (_systemId, moduleIds) => moduleIds.includes("inactive-module"),
    });
    const manager = new IntegrationManager(fakeClient(SYSTEM, MODULES), [moduleIntegration]);

    await manager.refresh();

    assert.deepEqual(manager.getActive(), []);
  });

  void it("fires onChange exactly once when the active set actually changes, and not on a repeat refresh() with no change", async () => {
    const dnd5e = makeIntegration({
      id: "dnd5e",
      kind: "system",
      detect: (systemId) => systemId === "dnd5e",
    });
    const manager = new IntegrationManager(fakeClient(SYSTEM, MODULES), [dnd5e]);

    let calls = 0;
    let lastActive: Integration[] = [];
    manager.onChange((active) => {
      calls++;
      lastActive = active;
    });

    await manager.refresh();
    assert.equal(calls, 1);
    assert.deepEqual(
      lastActive.map((i) => i.id),
      ["dnd5e"],
    );

    await manager.refresh();
    assert.equal(calls, 1, "refreshing again with no change should not re-fire onChange");
  });

  void it("gates activation on minVersion: a matching system below minVersion does not activate", async () => {
    const dnd5e = makeIntegration({
      id: "dnd5e",
      kind: "system",
      detect: (systemId) => systemId === "dnd5e",
      minVersion: "4.0.0",
    });
    const manager = new IntegrationManager(fakeClient(SYSTEM, MODULES), [dnd5e]);

    await manager.refresh();

    assert.deepEqual(manager.getActive(), []);
  });

  void it("gates activation on maxVersion: a matching system above maxVersion does not activate", async () => {
    const dnd5e = makeIntegration({
      id: "dnd5e",
      kind: "system",
      detect: (systemId) => systemId === "dnd5e",
      maxVersion: "3.0.0",
    });
    const manager = new IntegrationManager(fakeClient(SYSTEM, MODULES), [dnd5e]);

    await manager.refresh();

    assert.deepEqual(manager.getActive(), []);
  });

  void it("allows a matching system within an inclusive minVersion/maxVersion range", async () => {
    const dnd5e = makeIntegration({
      id: "dnd5e",
      kind: "system",
      detect: (systemId) => systemId === "dnd5e",
      minVersion: "3.3.1",
      maxVersion: "3.3.1",
    });
    const manager = new IntegrationManager(fakeClient(SYSTEM, MODULES), [dnd5e]);

    await manager.refresh();

    assert.deepEqual(
      manager.getActive().map((i) => i.id),
      ["dnd5e"],
    );
  });

  void it("stops future notifications once unsubscribed via the returned function", async () => {
    const dnd5e = makeIntegration({
      id: "dnd5e",
      kind: "system",
      detect: (systemId) => systemId === "dnd5e",
    });
    const manager = new IntegrationManager(fakeClient(SYSTEM, MODULES), [dnd5e]);

    let calls = 0;
    const unsubscribe = manager.onChange(() => calls++);
    unsubscribe();

    await manager.refresh();

    assert.equal(calls, 0);
  });
});
