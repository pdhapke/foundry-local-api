import assert from "node:assert/strict";
import test from "node:test";
import { applyGmScene, readGmScene } from "./gm-scene.js";
import type { NativeGmApplyInput } from "@foundry-local-api/shared";

class Doc {
  actor?: Doc;
  children = new Map<string, Doc>();
  combatants = new Map<string, Doc>();
  turns: Doc[] = [];
  onUpdate?: () => void;
  moves = 0;
  object = { constrainMovementPath: () => [[], false] };
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
  async update(patch: Record<string, unknown>) {
    for (const [path, value] of Object.entries(patch)) {
      const bits = path.split(".");
      let target = this.data;
      for (const bit of bits.slice(0, -1)) target = target[bit] ??= {};
      target[bits.at(-1)!] = structuredClone(value);
    }
    this.onUpdate?.();
    return this;
  }
  async move(destination: Record<string, unknown>) {
    this.moves++;
    Object.assign(this.data, destination);
    return true;
  }
}
function fixture() {
  const gm = { id: "gm", isGM: true, active: true };
  const scene = new Doc("s", { active: true, grid: { units: "ft" } });
  const token = new Doc("t", { actorId: "a", x: 1, y: 2, elevation: 0 });
  token.actor = new Doc("a", { system: { attributes: { movement: { units: "ft", walk: 30 } } } });
  scene.children.set(token.id, token);
  const c = new Doc("c", { tokenId: "t", actorId: "a" });
  c.actor = token.actor;
  const combat = new Doc("combat", { scene: "s", round: 1, turn: 0 });
  combat.combatants.set(c.id, c);
  combat.turns = [c];
  const ledger = new Doc("budget", {
    ownership: { default: 0 },
    flags: {
      "foundry-local-api": {
        gmCombatLedger: {
          worldId: "w",
          combatId: combat.id,
          ledger: {
            version: 1,
            revision: 0,
            cursor: "1:0:c",
            budgets: {
              c: {
                action: 1,
                bonus: 1,
                reaction: 1,
                movement: 30,
                movementBase: 30,
                movementMode: "walk",
                turnKey: "1:0:c",
              },
            },
            ready: [],
            interrupts: [],
            decisions: [],
          },
        },
      },
    },
  });
  const receipts = new Doc("receipts", {
    ownership: { default: 0 },
    flags: { "foundry-local-api": { nativeGmVersion: "gm-actions-v1", nativeGmReceipts: {} } },
  });
  Object.assign(globalThis, {
    game: {
      world: { id: "w" },
      user: gm,
      users: new Map([["gm", gm]]),
      release: { version: "14.368" },
      system: { id: "dnd5e", version: "6.0.3" },
      collections: new Map([
        ["Scene", new Map([["s", scene]])],
        ["Combat", new Map([[combat.id, combat]])],
        [
          "JournalEntry",
          new Map([
            [ledger.id, ledger],
            [receipts.id, receipts],
          ]),
        ],
      ]),
    },
    canvas: { scene },
    CONFIG: { Token: { movement: { actions: { walk: { walls: "move", teleport: false } } } } },
  });
  const input: NativeGmApplyInput = {
    schemaVersion: "gm-actions-v1",
    worldId: "w",
    userId: "gm",
    sceneId: "s",
    action: {
      kind: "token.move",
      tokenId: "t",
      x: 11,
      y: 12,
      mode: "walk",
      movementCost: 5,
      ruling: "Explicit five feet movement",
    },
    expectedState: {},
    idempotencyKey: "move",
    correlationId: "move",
  };
  input.expectedState = readGmScene(input);
  return { input, token, scene, combat, ledger };
}
void test("independent: movement outer reservation debits once and exact replay does not repeat", async () => {
  const { input, token, ledger } = fixture();
  assert.equal((await applyGmScene(input)).outcome, "confirmed");
  assert.equal((await applyGmScene(input)).outcome, "confirmed");
  assert.equal(token.moves, 1);
  assert.equal(ledger.data.flags["foundry-local-api"].gmCombatLedger.ledger.budgets.c.movement, 25);
});
for (const changed of ["position", "token", "cursor"] as const)
  void test(`independent: ${changed} changed during movement budget persistence prevents stale move`, async () => {
    const { input, token, scene, combat, ledger } = fixture();
    ledger.onUpdate = () => {
      if (changed === "position") token.data.x = 3;
      if (changed === "token") {
        const replacement = new Doc("t", token.toObject());
        replacement.actor = token.actor!;
        scene.children.set("t", replacement);
      }
      if (changed === "cursor") combat.data.round = 2;
    };
    assert.equal((await applyGmScene(input)).outcome, "uncertain");
    assert.equal(
      token.moves,
      0,
      "must not dispatch movement after scope/state changed during budget persistence",
    );
  });
