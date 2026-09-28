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
});
