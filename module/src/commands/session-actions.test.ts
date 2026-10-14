import assert from "node:assert/strict";
import test from "node:test";
import { applySessionAction, readSessionAction } from "./session-actions.js";
import type { SessionAction, SessionActionInput } from "@foundry-local-api/shared";
class Doc {
  actor?: Doc;
  statuses = new Set<string>();
  effects = new Map<string, Doc>();
  turns: Doc[] = [];
  combatants = new Map<string, Doc>();
  sounds = new Map<string, Doc>();
  sound = { currentTime: 12 };
  children = new Map<string, Map<string, Doc>>();
  calls: Record<string, unknown>[] = [];
  object = { constrainMovementPath: (path: Record<string, unknown>[]) => [path, false] };
  constructor(
    readonly id: string,
    readonly data: Record<string, unknown>,
  ) {}
  toObject() {
    return structuredClone(this.data);
  }
  getEmbeddedCollection(name: string) {
    return this.children.get(name) ?? new Map<string, Doc>();
  }
  async update(changes: Record<string, unknown>, options?: Record<string, unknown>) {
    this.calls.push({ changes, options });
    for (const [k, v] of Object.entries(changes)) {
      if (k === "system.attributes.hp.value")
        (this.data["system"] as { attributes: { hp: { value: unknown } } }).attributes.hp.value = v;
      else this.data[k] = v;
    }
    return this;
  }
  async nextTurn() {
    const next = Number(this.data["turn"]) + 1;
    const changes = {
      round: Number(this.data["round"]) + (next >= this.turns.length ? 1 : 0),
      turn: next >= this.turns.length ? 0 : next,
    };
    const options = { direction: 1, worldTime: { delta: 6 } };
    (globalThis as any).Hooks.callAll(
      next >= this.turns.length ? "combatRound" : "combatTurn",
      this,
      changes,
      options,
    );
    await this.update(changes, options);
    return this;
  }
  async move(destination: Record<string, unknown>, options: Record<string, unknown>) {
    await this.update({ x: destination["x"], y: destination["y"] }, options);
    return true;
  }
  async toggleStatusEffect(id: string, options: Record<string, unknown>) {
    this.calls.push({ options });
    if (options["active"]) this.statuses.add(id);
    else this.statuses.delete(id);
  }
  async deleteEmbeddedDocuments(_name: string, ids: string[], options: Record<string, unknown>) {
    this.calls.push({ options });
    for (const id of ids) {
      const effect = this.effects.get(id);
      for (const status of effect?.statuses ?? []) this.statuses.delete(status);
      this.effects.delete(id);
    }
  }
}
function fixture() {
  let hookId = 0;
  const listeners = new Map<number, { event: string; callback: (...args: unknown[]) => void }>();
  (globalThis as any).Hooks = {
    on: (event: string, callback: (...args: unknown[]) => void) => {
      listeners.set(++hookId, { event, callback });
      return hookId;
    },
    off: (_event: string, id: number) => listeners.delete(id),
    callAll: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.values())
        if (listener.event === event) listener.callback(...args);
    },
  };
  const actor = new Doc("a", { system: { attributes: { hp: { value: 8, max: 10 } } } });
  const token = new Doc("t", { x: 1, y: 2 });
  token.actor = actor;
  const door = new Doc("d", { door: 1, ds: 0 });
  const scene = new Doc("s", { active: true, width: 100, height: 100 });
  scene.children.set("Token", new Map([["t", token]]));
  scene.children.set("Wall", new Map([["d", door]]));
  const c = new Doc("c", { active: true, scene: "s", round: 1, turn: 0 });
  const combatant = new Doc("ct", { initiative: 5 });
  c.combatants.set("ct", combatant);
  c.turns = [combatant, combatant];
  const p = new Doc("p", {});
  const sound = new Doc("sound", { playing: false, pausedTime: null });
  p.sounds.set("sound", sound);
  const gm = { id: "gm", isGM: true, active: true };
  const messages = new Map<string, Doc>();
  Object.assign(globalThis, {
    game: {
      world: { id: "w" },
      user: gm,
      users: new Map([["gm", gm]]),
      system: { id: "dnd5e" },
      collections: new Map([
        ["Scene", new Map([["s", scene]])],
        ["Combat", new Map([["c", c]])],
        ["Playlist", new Map([["p", p]])],
        ["ChatMessage", messages],
      ]),
    },
    CONFIG: {
      Token: { movement: { actions: { walk: { walls: "move" }, displace: { walls: null, teleport: true } } } },
      statusEffects: [{ id: "prone" }],
      ActiveEffect: {
        documentClass: {
          fromStatusEffect: async (id: string) => ({ toObject: () => ({ statuses: [id] }) }),
          create: async (data: Record<string, unknown>, options: Record<string, unknown>) => {
            const effect = new Doc("effect", data);
            effect.statuses = new Set(data["statuses"] as string[]);
            actor.effects.set(effect.id, effect);
            for (const id of effect.statuses) actor.statuses.add(id);
            actor.calls.push({ options });
            return effect;
          },
        },
      },
      ChatMessage: {
        documentClass: {
          create: async (data: Record<string, unknown>) => {
            const message = new Doc("m", data);
            messages.set("m", message);
            return message;
          },
        },
      },
    },
  });
  return { actor, token, door, scene, c, combatant, sound, gm };
}
const input = (action: SessionAction): SessionActionInput => ({
  worldId: "w",
  requestingUserId: "gm",
  action,
});
const apply = (action: SessionAction) => {
  const i = input(action);
  return applySessionAction({
    ...i,
    expectedState: readSessionAction(i).state,
    correlationId: "corr",
    idempotencyKey: "key",
  });
};
void test("narrow session setters preflight and read back exact state (mocked Foundry)", async () => {
  const f = fixture();
  assert.deepEqual(
    (await apply({ kind: "actor.hp", sceneId: "s", targetId: "a", value: 6 })).state,
    { value: 6, max: 10 },
  );
  assert.deepEqual(
    (await apply({ kind: "door.state", sceneId: "s", targetId: "d", value: 1 })).state,
    { ds: 1 },
  );
  assert.deepEqual(
    (await apply({ kind: "token.position", sceneId: "s", targetId: "t", x: 20, y: 25 })).state,
    { x: 20, y: 25 },
  );
  assert.deepEqual((await apply({ kind: "combat.next", sceneId: "s", targetId: "c" })).state, {
    round: 1,
    turn: 1,
    turnCount: 2,
  });
  assert.deepEqual((await apply({ kind: "combat.next", sceneId: "s", targetId: "c" })).state, {
    round: 2,
    turn: 0,
    turnCount: 2,
  });
  assert.equal(
    (
      await apply({
        kind: "combat.initiative",
        sceneId: "s",
        targetId: "c",
        combatantId: "ct",
        value: 17,
      })
    ).state["initiative"],
    17,
  );
  assert.equal(
    (
      await apply({
        kind: "actor.condition",
        sceneId: "s",
        targetId: "a",
        conditionId: "prone",
        active: true,
      })
    ).state["active"],
    true,
  );
  const effectOptions = f.actor.calls.at(-1)!["options"] as Record<string, unknown>;
  assert.deepEqual(effectOptions["foundryLocalApiOrigin"], {
    source: "foundry-local-api.session-action",
    phase: "apply",
    correlationId: "corr",
  });
  assert.equal(
    (
      await apply({
        kind: "actor.condition",
        sceneId: "s",
        targetId: "a",
        conditionId: "prone",
        active: false,
      })
    ).state["active"],
    false,
  );
  assert.deepEqual(
    (f.actor.calls.at(-1)!["options"] as Record<string, unknown>)["foundryLocalApiOrigin"],
    effectOptions["foundryLocalApiOrigin"],
  );
  assert.equal(
    f.c.data["turnCount"],
    undefined,
    "preflight turnCount is not a document update field",
  );
  assert.equal(
    (await apply({ kind: "playlist.sound", targetId: "p", soundId: "sound", state: "paused" }))
      .state["pausedTime"],
    12,
  );
  assert.deepEqual(
    (await apply({ kind: "playlist.sound", targetId: "p", soundId: "sound", state: "stopped" }))
      .state,
    { playing: false, pausedTime: null },
  );
  const chat = await apply({ kind: "chat.post", text: "A bell rings." });
  assert.deepEqual(
    readSessionAction(
      input({
        kind: "chat.post",
        text: "A bell rings.",
        messageId: String(chat.state["messageId"]),
      }),
    ).state,
    chat.state,
  );
  const options = f.token.calls[0]!["options"] as Record<string, unknown>;
  assert.equal(options["correlationId"], "corr");
  assert.deepEqual(options["foundryLocalApiOrigin"], {
    source: "foundry-local-api.session-action",
    phase: "apply",
    correlationId: "corr",
  });
});
void test("stale/revoked/cross-world and invalid semantic actions fail before mutation (mocked Foundry)", async () => {
  const f = fixture();
  const a: SessionAction = { kind: "door.state", sceneId: "s", targetId: "d", value: 1 };
  const i = input(a);
  const state = readSessionAction(i).state;
  f.door.data["ds"] = 2;
  await assert.rejects(
    applySessionAction({ ...i, expectedState: state, correlationId: "c", idempotencyKey: "k" }),
    /Stale/,
  );
  assert.equal(f.door.calls.length, 0);
  assert.throws(() => readSessionAction({ ...i, worldId: "other" }), /authorization/);
  f.gm.active = false;
  assert.throws(() => readSessionAction(i), /authorization/);
  f.gm.active = true;
  f.scene.data["active"] = false;
  assert.throws(() => readSessionAction(i), /active scene/);
  f.scene.data["active"] = true;
  assert.throws(
    () => readSessionAction(input({ kind: "actor.hp", sceneId: "s", targetId: "a", value: 11 })),
    /maximum/,
  );
  assert.throws(
    () =>
      readSessionAction(
        input({ kind: "token.position", sceneId: "s", targetId: "t", x: 101, y: 2 }),
      ),
    /bounds/,
  );
  assert.throws(
    () =>
      readSessionAction(
        input({
          kind: "actor.condition",
          sceneId: "s",
          targetId: "a",
          conditionId: "unknown",
          active: true,
        }),
      ),
    /Trusted/,
  );
  assert.throws(() => readSessionAction(input({ kind: "chat.post", text: "<script>" })), /Plain/);
});
void test("mismatching authoritative post-read is uncertain and never retried (mocked Foundry)", async () => {
  const f = fixture();
  let attempts = 0;
  f.door.update = async () => {
    attempts++;
    return f.door;
  };
  await assert.rejects(
    apply({ kind: "door.state", sceneId: "s", targetId: "d", value: 1 }),
    /read-back mismatch; result uncertain/,
  );
  assert.equal(attempts, 1);
});
