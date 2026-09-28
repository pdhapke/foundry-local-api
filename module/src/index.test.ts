import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  ASSET_COMMANDS,
  CLIENT_READINESS_COMMANDS,
  COLLISION_COMMANDS,
  DND5E_SIMULATION_COMMANDS,
  EFFECTIVE_USER_COMMANDS,
  EMBEDDED_CHILD_COMMANDS,
  FOG_EXPLORATION_COMMANDS,
  MOVEMENT_COMMANDS,
  REFERENCE_AUDIT_COMMAND,
  SCENE_RENDER_COMMANDS,
  SCHEMA_DISCOVERY_COMMANDS,
  TRAILS_COMMANDS,
  TRANSACTION_COMMANDS,
} from "@foundry-local-api/shared";

import { listRegisteredCommands } from "./command-registry.js";

const PHASE_3_COMMANDS = [
  TRAILS_COMMANDS.CONFIG,
  TRAILS_COMMANDS.ACTOR_SHEET,
  TRAILS_COMMANDS.ACTOR_INVENTORY,
  TRAILS_COMMANDS.LIST_CATALOGS,
  TRAILS_COMMANDS.GET_CATALOG,
  TRAILS_COMMANDS.EVALUATE_CREATION,
] as const;

const REQUIREMENT_COMMANDS = [
  ...Object.values(SCHEMA_DISCOVERY_COMMANDS),
  ...Object.values(EFFECTIVE_USER_COMMANDS),
  ...Object.values(TRANSACTION_COMMANDS),
  ...Object.values(FOG_EXPLORATION_COMMANDS),
  ...Object.values(SCENE_RENDER_COMMANDS),
  ...Object.values(CLIENT_READINESS_COMMANDS),
  ...Object.values(EMBEDDED_CHILD_COMMANDS),
  ...Object.values(ASSET_COMMANDS),
  REFERENCE_AUDIT_COMMAND,
  ...Object.values(COLLISION_COMMANDS),
  ...Object.values(DND5E_SIMULATION_COMMANDS),
  ...Object.values(MOVEMENT_COMMANDS),
] as const;

const savedConfig = Object.getOwnPropertyDescriptor(globalThis, "CONFIG");
const savedGame = Object.getOwnPropertyDescriptor(globalThis, "game");
const savedHooks = Object.getOwnPropertyDescriptor(globalThis, "Hooks");

function restoreGlobal(name: "CONFIG" | "game" | "Hooks", descriptor?: PropertyDescriptor): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

void describe("module entrypoint Trails wiring", () => {
  before(async () => {
    Reflect.deleteProperty(globalThis, "CONFIG");
    Reflect.deleteProperty(globalThis, "game");
    Object.defineProperty(globalThis, "Hooks", {
      configurable: true,
      writable: true,
      value: { once: () => undefined },
    });

    await import("./index.js");
  });

  after(() => {
    restoreGlobal("CONFIG", savedConfig);
    restoreGlobal("game", savedGame);
    restoreGlobal("Hooks", savedHooks);
  });

  void it("imports without Trails or Foundry game globals", () => {
    assert.equal("CONFIG" in globalThis, false);
    assert.equal("game" in globalThis, false);
  });

  void it("registers every Phase 3 Trails command exactly once", () => {
    const registered = listRegisteredCommands();

    for (const command of PHASE_3_COMMANDS) {
      assert.equal(
        registered.filter((registeredCommand) => registeredCommand === command).length,
        1,
        command,
      );
    }
  });

  void it("registers every MCP requirement command exactly once", () => {
    const registered = listRegisteredCommands();
    for (const command of REQUIREMENT_COMMANDS) {
      assert.equal(
        registered.filter((registeredCommand) => registeredCommand === command).length,
        1,
        command,
      );
    }
  });
});
