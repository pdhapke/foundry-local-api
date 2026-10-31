import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { BridgeClient } from "./bridge-client.js";
import {
  captureTokenMovement,
  completeTokenMovement,
  MOVEMENT_EVENT_NAME,
  registerMovementEventHooks,
  sceneMovementRegions,
} from "./movement-event-hooks.js";

const savedHooks = Object.getOwnPropertyDescriptor(globalThis, "Hooks");
const savedGame = Object.getOwnPropertyDescriptor(globalThis, "game");
afterEach(() => {
  if (savedHooks) Object.defineProperty(globalThis, "Hooks", savedHooks);
  else Reflect.deleteProperty(globalThis, "Hooks");
  if (savedGame) Object.defineProperty(globalThis, "game", savedGame);
  else Reflect.deleteProperty(globalThis, "game");
});

void describe("automatic movement hook capture", () => {
  void it("filters unrelated updates and derives narrow Region transitions from actual Scene data", () => {
    const callbacks = new Map<string, (...args: unknown[]) => void>();
    Object.defineProperty(globalThis, "Hooks", {
      configurable: true,
      value: {
        on: (name: string, callback: (...args: unknown[]) => void) => {
          callbacks.set(name, callback);
          return callbacks.size;
        },
      },
    });
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "gm", isGM: true },
        users: new Map([["user", { id: "user", isGM: false }]]),
      },
    });
    const sent: Array<{ name: string; payload: unknown }> = [];
    const client = {
      sendEvent: (name: string, payload: unknown) => sent.push({ name, payload }),
    } as unknown as BridgeClient;
    const region = {
      id: "hazard",
      toObject: () => ({
        name: "Narrow Hazard",
        shapes: [{ type: "polygon", points: [4, 0, 5, 0, 5, 2, 4, 2] }],
      }),
    };
    const scene = {
      id: "scene",
      getEmbeddedCollection: (name: string) =>
        name === "Region" ? new Map([[region.id, region]]) : new Map(),
    } as unknown as FoundryScene;
    const token = {
      id: "token",
      parent: scene,
      toObject: () => ({ _id: "token", x: 0, y: 1, elevation: 0 }),
      testUserPermission: () => true,
    };
    registerMovementEventHooks(client);
    callbacks.get("preUpdateToken")!(token, { name: "ignored" }, {}, "user");
    callbacks.get("updateToken")!(token, { name: "ignored" }, {}, "user");
    assert.equal(sent.length, 0);
    callbacks.get("preUpdateToken")!(
      token,
      { x: 10 },
      { correlationId: "correlation-1", movement: { waypoints: [{ x: 3, y: 1 }] } },
      "user",
    );
    callbacks.get("updateToken")!(token, { x: 10 }, {}, "user");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.name, MOVEMENT_EVENT_NAME);
    const payload = sent[0]!.payload as { eventId: string; transitions: Array<{ kind: string }> };
    assert.equal(payload.eventId, "correlation-1");
    assert.deepEqual(
      payload.transitions.map((transition) => transition.kind),
      ["enter", "exit"],
    );
  });

  void it("does not duplicate movement events from non-GM observing clients", () => {
    const callbacks = new Map<string, (...args: unknown[]) => void>();
    Object.defineProperty(globalThis, "Hooks", {
      configurable: true,
      value: {
        on: (name: string, callback: (...args: unknown[]) => void) => {
          callbacks.set(name, callback);
          return callbacks.size;
        },
      },
    });
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: { user: { isGM: false } },
    });
    const sent: unknown[] = [];
    registerMovementEventHooks({
      sendEvent: (_name: string, payload: unknown) => sent.push(payload),
    } as unknown as BridgeClient);
    const scene = {
      id: "scene",
      getEmbeddedCollection: () => new Map(),
    } as unknown as FoundryScene;
    const token = {
      id: "token",
      parent: scene,
      toObject: () => ({ _id: "token", x: 0, y: 0 }),
    };
    callbacks.get("preUpdateToken")!(token, { x: 1 }, {}, "user");
    callbacks.get("updateToken")!(token, { x: 1 }, {}, "user");
    assert.equal(sent.length, 0);
  });

  void it("reads v14 nested elevation, rotated rectangles, absolute polygons, and holes", () => {
    let toObjectCalls = 0;
    const scene = {
      getEmbeddedCollection: () =>
        new Map([
          [
            "r",
            {
              id: "r",
              toObject: () => {
                toObjectCalls++;
                return {
                  elevation: { bottom: -5, top: 15 },
                  shapes: [
                    {
                      type: "rectangle",
                      x: 10,
                      y: 20,
                      width: 4,
                      height: 2,
                      rotation: 90,
                      anchorX: 0.5,
                      anchorY: 0.5,
                    },
                    {
                      type: "polygon",
                      points: [11, 20, 13, 20, 13, 21, 11, 21],
                      origin: { x: 12, y: 20.5 },
                      hole: true,
                    },
                  ],
                };
              },
            },
          ],
        ]),
    } as unknown as FoundryScene;
    const parsed = sceneMovementRegions(scene)[0]!;
    assert.deepEqual(parsed.polygons[0], [
      { x: 11, y: 18 },
      { x: 11, y: 22 },
      { x: 9, y: 22 },
      { x: 9, y: 18 },
    ]);
    assert.deepEqual(parsed.holes, [
      [
        { x: 11, y: 20 },
        { x: 13, y: 20 },
        { x: 13, y: 21 },
        { x: 11, y: 21 },
      ],
    ]);
    assert.equal(parsed.bottom, -5);
    assert.equal(parsed.top, 15);
    assert.equal(toObjectCalls, 1);
  });

  void it("parses v14 circle and rotated ellipse geometry", () => {
    const scene = {
      getEmbeddedCollection: () =>
        new Map([
          [
            "curves",
            {
              id: "curves",
              toObject: () => ({
                elevation: { bottom: 0, top: 10 },
                shapes: [
                  { type: "circle", x: 50, y: 60, radius: 10, hole: false },
                  {
                    type: "ellipse",
                    x: 100,
                    y: 120,
                    radiusX: 20,
                    radiusY: 5,
                    rotation: 90,
                    hole: false,
                  },
                ],
              }),
            },
          ],
        ]),
    } as unknown as FoundryScene;
    const [circle, ellipse] = sceneMovementRegions(scene)[0]!.polygons;
    assert.ok(circle!.length >= 4);
    assert.deepEqual(circle![0], { x: 60, y: 60 });
    assert.ok(Math.abs(ellipse![0]!.x - 100) < 1e-9);
    assert.ok(Math.abs(ellipse![0]!.y - 140) < 1e-9);
    const quarter = ellipse![Math.round(ellipse!.length / 4)]!;
    assert.ok(Math.abs(quarter.x - 95) < 1e-9);
    assert.ok(Math.abs(quarter.y - 120) < 1e-9);
  });

  void it("fails closed without silently omitting malformed or unsupported v14 Region shapes", () => {
    const sources = [
      { shapes: [{ type: "cone", x: 0, y: 0, radius: 10 }] },
      { shapes: [{ type: "polygon", points: [0, 0, Number.NaN, 0, 0, 1] }] },
      { shapes: [{ type: "rectangle", x: 0, y: 0, width: 1, height: 1, hole: "yes" }] },
      { shapes: [] },
      {
        shapes: [
          { type: "rectangle", x: 0, y: 0, width: 10, height: 10, hole: false },
          { type: "rectangle", x: 2, y: 2, width: 2, height: 2, hole: true },
          { type: "circle", x: 5, y: 5, radius: 1, hole: false },
        ],
      },
      { shapes: [{ type: "circle", x: 0, y: 0, radius: 5, gridBased: true }] },
    ];
    const scene = {
      getEmbeddedCollection: () =>
        new Map(
          sources.map((source, index) => [
            `region-${index}`,
            { id: `region-${index}`, toObject: () => source },
          ]),
        ),
    } as unknown as FoundryScene;
    const parsed = sceneMovementRegions(scene);
    assert.equal(parsed.length, sources.length);
    assert.ok(parsed.every((region) => (region.incompleteReasons?.length ?? 0) > 0));
    assert.match(parsed[4]!.incompleteReasons!.join(" "), /interleaved additive shapes and holes/);
    assert.match(parsed[5]!.incompleteReasons!.join(" "), /grid-based geometry/);
  });

  void it("reports incomplete geometry and emits no false transition for an unsupported Region", () => {
    const player = { id: "player", isGM: false };
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: { users: new Map([[player.id, player]]) },
    });
    const region = {
      id: "unsupported",
      toObject: () => ({ shapes: [{ type: "cone", x: 5, y: 0, radius: 2 }] }),
    };
    const scene = {
      id: "scene-unsupported",
      getEmbeddedCollection: () => new Map([[region.id, region]]),
    } as unknown as FoundryScene;
    const token = {
      id: "token-unsupported",
      parent: scene,
      toObject: () => ({ x: 0, y: 0, width: 0, height: 0 }),
      testUserPermission: () => true,
    } as unknown as Parameters<typeof captureTokenMovement>[0];
    captureTokenMovement(token, { x: 10 }, { correlationId: "unsupported" }, player.id);
    const event = completeTokenMovement(token, player.id)!;
    assert.equal(event.geometryStatus, "incomplete");
    assert.match(event.incompleteReasons.join(" "), /unsupported.*cone/);
    assert.deepEqual(event.transitions, []);
  });

  void it("uses v14 token-keyed and prepared passed waypoints without losing path segments", () => {
    const player = { id: "player", isGM: false };
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: { users: new Map([[player.id, player]]) },
    });
    const scene = {
      id: "scene-keyed",
      getEmbeddedCollection: () => new Map(),
    } as unknown as FoundryScene;
    const token = {
      id: "token-keyed",
      parent: scene,
      toObject: () => ({ x: 0, y: 0, elevation: 4 }),
      testUserPermission: () => true,
    } as unknown as Parameters<typeof captureTokenMovement>[0];
    captureTokenMovement(
      token,
      { x: 12 },
      {
        movement: {
          "token-keyed": { waypoints: [{ x: 99, y: 99 }] },
          other: { waypoints: [{ x: 88, y: 88 }] },
        },
        _movement: {
          "token-keyed": {
            passed: {
              waypoints: [
                { x: 0, y: 0, elevation: 4 },
                { x: 3, y: 1 },
                { x: 3, y: 1 },
                { x: 8, y: 2, elevation: 7 },
              ],
            },
          },
        },
      },
      player.id,
    );
    const event = completeTokenMovement(token, player.id)!;
    assert.deepEqual(event.waypoints, [
      { x: 0, y: 0, elevation: 4 },
      { x: 3, y: 1, elevation: 4 },
      { x: 3, y: 1, elevation: 4 },
      { x: 8, y: 2, elevation: 7 },
      { x: 12, y: 0, elevation: 4 },
    ]);
    assert.equal(event.segments.length, 4);
  });

  void it("marks keyed movement metadata incomplete instead of guessing an unreadable path", () => {
    const player = { id: "player", isGM: false };
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: { users: new Map([[player.id, player]]) },
    });
    const scene = {
      id: "scene-malformed",
      getEmbeddedCollection: () =>
        new Map([
          [
            "crossed",
            {
              id: "crossed",
              toObject: () => ({
                shapes: [{ type: "rectangle", x: 4, y: -1, width: 2, height: 2 }],
              }),
            },
          ],
        ]),
    } as unknown as FoundryScene;
    const token = {
      id: "token-malformed",
      parent: scene,
      toObject: () => ({ x: 0, y: 0 }),
      testUserPermission: () => true,
    } as unknown as Parameters<typeof captureTokenMovement>[0];
    captureTokenMovement(
      token,
      { x: 10 },
      { movement: { "token-malformed": { waypoints: [{ x: "bad", y: 2 }] } } },
      player.id,
    );
    const event = completeTokenMovement(token, player.id)!;
    assert.equal(event.geometryStatus, "incomplete");
    assert.match(event.incompleteReasons.join(" "), /non-finite coordinates/);
    assert.deepEqual(event.transitions, []);
    assert.deepEqual(event.waypoints, [
      { x: 0, y: 0, elevation: 0 },
      { x: 10, y: 0, elevation: 0 },
    ]);
  });

  void it("uses actual constrained Region polygons and fails closed when they are unavailable", () => {
    const restricted = {
      id: "restricted",
      polygons: [{ points: [4, 0, 6, 0, 6, 2, 4, 2] }],
      toObject: () => ({
        restriction: { enabled: true, type: "move", priority: 0 },
        _shapeConstraints: [[4, 0, 6, 0, 6, 2, 4, 2]],
        shapes: [{ type: "rectangle", x: 0, y: 0, width: 10, height: 2 }],
      }),
    };
    const missing = {
      id: "missing",
      toObject: () => ({
        restriction: { enabled: true, type: "move", priority: 0 },
        _shapeConstraints: [[1, 0, 2, 0, 2, 2, 1, 2]],
        shapes: [{ type: "rectangle", x: 0, y: 0, width: 10, height: 2 }],
      }),
    };
    const scene = {
      getEmbeddedCollection: () =>
        new Map([
          [restricted.id, restricted],
          [missing.id, missing],
        ]),
    } as unknown as FoundryScene;
    const [supported, unsupported] = sceneMovementRegions(scene);
    assert.deepEqual(supported!.polygons, [
      [
        { x: 4, y: 0 },
        { x: 6, y: 0 },
        { x: 6, y: 2 },
        { x: 4, y: 2 },
      ],
    ]);
    assert.equal(supported!.incompleteReasons, undefined);
    assert.match(unsupported!.incompleteReasons!.join(" "), /constrained Region polygons/);
  });

  void it("throws explicitly when the Region collection cannot be read", () => {
    const scene = {
      getEmbeddedCollection: () => {
        throw new Error("unavailable");
      },
    } as unknown as FoundryScene;
    assert.throws(() => sceneMovementRegions(scene), /movement geometry is unavailable/);
  });

  void it("requires initiating-user ownership at capture and completion", () => {
    const player = { id: "player", isGM: false };
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: { users: new Map([[player.id, player]]) },
    });
    let owns = false;
    const scene = {
      id: "scene-owner",
      getEmbeddedCollection: () => new Map(),
    } as unknown as FoundryScene;
    const token = {
      id: "token-owner",
      parent: scene,
      toObject: () => ({ x: 0, y: 0 }),
      testUserPermission: (user: unknown, permission: string) =>
        user === player && permission === "OWNER" && owns,
    } as unknown as Parameters<typeof captureTokenMovement>[0];
    captureTokenMovement(token, { x: 1 }, { correlationId: "denied" }, player.id);
    assert.equal(completeTokenMovement(token, player.id), undefined);
    owns = true;
    captureTokenMovement(token, { x: 1 }, { correlationId: "revoked" }, player.id);
    owns = false;
    assert.equal(completeTokenMovement(token, player.id), undefined);
    owns = true;
    captureTokenMovement(token, { x: 1 }, { correlationId: "allowed" }, player.id);
    assert.equal(completeTokenMovement(token, player.id)?.eventId, "allowed");
  });

  void it("suppresses setup and unauthorized GM movement while preserving player authorship", () => {
    const callbacks = new Map<string, (...args: unknown[]) => void>();
    Object.defineProperty(globalThis, "Hooks", {
      configurable: true,
      value: {
        on: (name: string, callback: (...args: unknown[]) => void) => {
          callbacks.set(name, callback);
          return 1;
        },
      },
    });
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: { id: "gm", isGM: true },
        users: new Map([
          ["gm", { id: "gm", isGM: true }],
          ["player", { id: "player", isGM: false }],
        ]),
      },
    });
    const sent: unknown[] = [];
    registerMovementEventHooks({
      sendEvent: (_name: string, payload: unknown) => sent.push(payload),
    } as unknown as BridgeClient);
    const scene = {
      id: "scene",
      grid: { size: 100 },
      getEmbeddedCollection: () => new Map(),
    } as unknown as FoundryScene;
    const token = {
      id: "token",
      parent: scene,
      toObject: () => ({ x: 0, y: 0, width: 1, height: 1 }),
      testUserPermission: () => true,
    };
    callbacks.get("preUpdateToken")!(
      token,
      { x: 10 },
      { foundryLocalApi: { setup: true } },
      "player",
    );
    callbacks.get("updateToken")!(token, { x: 10 }, {}, "player");
    callbacks.get("preUpdateToken")!(token, { x: 10 }, {}, "gm");
    callbacks.get("updateToken")!(token, { x: 10 }, {}, "gm");
    callbacks.get("preUpdateToken")!(
      token,
      { x: 10 },
      { correlationId: "allowed", foundryLocalApi: { authorizedGmMovement: true } },
      "gm",
    );
    callbacks.get("updateToken")!(token, { x: 10 }, {}, "gm");
    assert.equal(sent.length, 1);
    assert.deepEqual(
      (sent[0] as { movementFields: string[]; footprint: { width: number } }).movementFields,
      ["x"],
    );
    assert.equal((sent[0] as { footprint: { width: number } }).footprint.width, 100);
  });

  void it("suppresses a GM initiator observed by a different GM unless explicitly authorized", () => {
    const reportingGm = { id: "gm-reporter", isGM: true };
    const initiatingGm = { id: "gm-initiator", isGM: true };
    const player = { id: "izzy", isGM: false };
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: reportingGm,
        users: new Map([
          [reportingGm.id, reportingGm],
          [initiatingGm.id, initiatingGm],
          [player.id, player],
        ]),
      },
    });
    const scene = {
      id: "scene-multiple-gms",
      getEmbeddedCollection: () => new Map(),
    } as unknown as FoundryScene;
    const token = {
      id: "token",
      parent: scene,
      toObject: () => ({ x: 0, y: 0 }),
      testUserPermission: () => true,
    } as unknown as Parameters<typeof captureTokenMovement>[0];
    captureTokenMovement(token, { x: 1 }, { correlationId: "blocked" }, initiatingGm.id);
    assert.equal(completeTokenMovement(token, initiatingGm.id), undefined);
    captureTokenMovement(
      token,
      { x: 1 },
      { correlationId: "gm-allowed", foundryLocalApi: { authorizedGmMovement: true } },
      initiatingGm.id,
    );
    assert.equal(completeTokenMovement(token, initiatingGm.id)?.eventId, "gm-allowed");
    captureTokenMovement(token, { x: 1 }, { correlationId: "izzy" }, player.id);
    assert.equal(completeTokenMovement(token, player.id)?.eventId, "izzy");
  });
});

void describe("GM observation of moves authored on another client", () => {
  type Payload = {
    eventId: string;
    userId: string;
    from: { x: number; y: number; elevation?: number };
    to: { x: number; y: number; elevation?: number };
    waypoints: Array<{ x: number; y: number; elevation?: number }>;
  };

  function setup(currentUser: { id: string; isGM: boolean }) {
    const callbacks = new Map<string, (...args: unknown[]) => void>();
    Object.defineProperty(globalThis, "Hooks", {
      configurable: true,
      value: {
        on: (name: string, callback: (...args: unknown[]) => void) => {
          callbacks.set(name, callback);
          return callbacks.size;
        },
      },
    });
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        user: currentUser,
        users: new Map([
          ["gm", { id: "gm", isGM: true }],
          ["player-1", { id: "player-1", isGM: false }],
          ["stranger", { id: "stranger", isGM: false }],
        ]),
      },
    });
    const sent: Payload[] = [];
    registerMovementEventHooks({
      sendEvent: (_name: string, payload: unknown) => sent.push(payload as Payload),
    } as unknown as BridgeClient);
    const scene = {
      id: "scene-1",
      grid: { size: 40 },
      getEmbeddedCollection: () => new Map(),
    } as unknown as FoundryScene;
    let position = { x: 440, y: 680, elevation: 0 };
    const token = {
      id: "token-1",
      parent: scene,
      toObject: () => ({ _id: "token-1", ...position, width: 1, height: 1 }),
      testUserPermission: (user: { id: string }) => user.id === "player-1",
    };
    const moveTo = (next: { x: number; y: number }) => {
      position = { ...position, ...next };
    };
    return { callbacks, sent, token, moveTo };
  }

  const playerMovement = {
    _movement: {
      "token-1": {
        id: "move-1",
        origin: { x: 440, y: 680, elevation: 0 },
        passed: {
          waypoints: [
            { x: 520, y: 680, elevation: 0 },
            { x: 520, y: 760, elevation: 0 },
          ],
        },
      },
    },
  };

  void it("emits one event for a player drag the GM only sees via updateToken", () => {
    const { callbacks, sent, token, moveTo } = setup({ id: "gm", isGM: true });
    // The player's own browser ran preUpdateToken; the GM client only gets updateToken.
    moveTo({ x: 520, y: 760 });
    callbacks.get("updateToken")!(token, { x: 520, y: 760 }, playerMovement, "player-1");
    assert.equal(sent.length, 1);
    const event = sent[0]!;
    assert.equal(event.userId, "player-1");
    assert.deepEqual(event.from, { x: 440, y: 680, elevation: 0 });
    assert.deepEqual(event.to, { x: 520, y: 760, elevation: 0 });
    assert.deepEqual(event.waypoints, [
      { x: 440, y: 680, elevation: 0 },
      { x: 520, y: 680, elevation: 0 },
      { x: 520, y: 760, elevation: 0 },
    ]);
    assert.equal(event.eventId, "scene-1:token-1:move-1");
  });

  void it("emits a GM's own authorized move exactly once when both hooks fire", () => {
    const { callbacks, sent, token, moveTo } = setup({ id: "gm", isGM: true });
    const options = {
      ...playerMovement,
      correlationId: "gm-move",
      foundryLocalApi: { authorizedGmMovement: true },
    };
    callbacks.get("preUpdateToken")!(token, { x: 520, y: 760 }, options, "gm");
    moveTo({ x: 520, y: 760 });
    callbacks.get("updateToken")!(token, { x: 520, y: 760 }, options, "gm");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.eventId, "gm-move");
    assert.equal(sent[0]!.userId, "gm");
  });

  void it("keeps GM-authored, setup, unowned, and origin-less moves suppressed", () => {
    const { callbacks, sent, token, moveTo } = setup({ id: "gm", isGM: true });
    moveTo({ x: 520, y: 760 });
    // Unauthorized GM move, both with and without the pre-hook on this client.
    callbacks.get("preUpdateToken")!(token, { x: 520, y: 760 }, playerMovement, "gm");
    callbacks.get("updateToken")!(token, { x: 520, y: 760 }, playerMovement, "gm");
    callbacks.get("updateToken")!(token, { x: 520, y: 760 }, playerMovement, "gm");
    // Setup move by a player.
    callbacks.get("updateToken")!(
      token,
      { x: 520, y: 760 },
      { ...playerMovement, foundryLocalApi: { setup: true } },
      "player-1",
    );
    // A user without ownership.
    callbacks.get("updateToken")!(token, { x: 520, y: 760 }, playerMovement, "stranger");
    // No broadcast origin: nothing is guessed.
    callbacks.get("updateToken")!(token, { x: 520, y: 760 }, {}, "player-1");
    callbacks.get("updateToken")!(
      token,
      { x: 520, y: 760 },
      { _movement: { "token-1": { passed: { waypoints: [] } } } },
      "player-1",
    );
    assert.equal(sent.length, 0);
  });

  void it("does not emit from a non-GM observer", () => {
    const { callbacks, sent, token, moveTo } = setup({ id: "player-1", isGM: false });
    moveTo({ x: 520, y: 760 });
    callbacks.get("updateToken")!(token, { x: 520, y: 760 }, playerMovement, "player-1");
    assert.equal(sent.length, 0);
  });

  void it("a GM pre-hook whose update never completed does not swallow a later player move", () => {
    const { callbacks, sent, token, moveTo } = setup({ id: "gm", isGM: true });
    const realNow = Date.now;
    try {
      let now = 1_000_000;
      Date.now = () => now;
      callbacks.get("preUpdateToken")!(
        token,
        { x: 600 },
        { foundryLocalApi: { authorizedGmMovement: true } },
        "gm",
      );
      now += 60_000;
      moveTo({ x: 520, y: 760 });
      callbacks.get("updateToken")!(token, { x: 520, y: 760 }, playerMovement, "player-1");
    } finally {
      Date.now = realNow;
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.userId, "player-1");
  });
});
