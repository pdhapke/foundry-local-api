import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { USER_COMMANDS } from "@foundry-local-api/shared";

import { dispatch } from "../command-registry.js";
import "./users.js";

const savedGame = Object.getOwnPropertyDescriptor(globalThis, "game");

function installUser(options: {
  isGM?: boolean;
  source?: Record<string, unknown>;
  update: (changes: Record<string, unknown>, updateOptions?: Record<string, unknown>) => void;
}): void {
  const source = options.source ?? { _id: "u1", name: "Test Player", password: "redacted-value" };
  const user = {
    id: "u1",
    name: "Test Player",
    role: 1,
    isGM: false,
    active: false,
    targets: new Set(),
    toObject: () => structuredClone(source),
    update: async (changes: Record<string, unknown>, updateOptions?: Record<string, unknown>) => {
      options.update(changes, updateOptions);
      return user;
    },
    delete: async () => user,
    query: async () => undefined,
  };
  Object.defineProperty(globalThis, "game", {
    configurable: true,
    value: {
      user: { isGM: options.isGM ?? true },
      users: new Map([[user.id, user]]),
    },
  });
}

void describe("User command password updates", () => {
  beforeEach(() => Reflect.deleteProperty(globalThis, "game"));
  afterEach(() => {
    if (savedGame) Object.defineProperty(globalThis, "game", savedGame);
    else Reflect.deleteProperty(globalThis, "game");
  });

  void it("forces an explicitly supplied blank password through Foundry without returning it", async () => {
    let deliveredChanges: Record<string, unknown> | undefined;
    let deliveredOptions: Record<string, unknown> | undefined;
    installUser({
      update: (changes, options) => {
        deliveredChanges = changes;
        deliveredOptions = options;
      },
    });

    const response = await dispatch({
      id: "request-1",
      type: USER_COMMANDS.UPDATE,
      payload: { userId: "u1", changes: { password: "" } },
    });

    assert.equal(response.ok, true);
    assert.deepEqual(deliveredChanges, { password: "" });
    assert.deepEqual(deliveredOptions, { diff: false });
    assert.deepEqual(response.result, { _id: "u1", name: "Test Player" });
  });

  void it("retains normal diff behavior when password was not explicitly supplied", async () => {
    let deliveredOptions: Record<string, unknown> | undefined;
    installUser({ update: (_changes, options) => (deliveredOptions = options) });

    const response = await dispatch({
      id: "request-2",
      type: USER_COMMANDS.UPDATE,
      payload: { userId: "u1", changes: { name: "Test Hero" } },
    });

    assert.equal(response.ok, true);
    assert.equal(deliveredOptions, undefined);
  });

  void it("rejects non-string password input without exposing its value or calling update", async () => {
    let updateCalled = false;
    installUser({ update: () => (updateCalled = true) });

    const response = await dispatch({
      id: "request-3",
      type: USER_COMMANDS.UPDATE,
      payload: { userId: "u1", changes: { password: { private: "do-not-echo" } } },
    });

    assert.equal(response.ok, false);
    assert.equal(updateCalled, false);
    assert.equal(response.error?.message, "A User password update must be a string.");
    assert.doesNotMatch(JSON.stringify(response), /do-not-echo/);
  });

  void it("preserves the GM-only guard before attempting a password update", async () => {
    let updateCalled = false;
    installUser({ isGM: false, update: () => (updateCalled = true) });

    const response = await dispatch({
      id: "request-4",
      type: USER_COMMANDS.UPDATE,
      payload: { userId: "u1", changes: { password: "" } },
    });

    assert.equal(response.ok, false);
    assert.equal(updateCalled, false);
    assert.match(response.error?.message ?? "", /Only a GM/);
  });
});
