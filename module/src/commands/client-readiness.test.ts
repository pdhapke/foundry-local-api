import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  applyClientViewport,
  getClientReadiness,
  preloadClientScene,
  requestClientReload,
} from "./client-readiness.js";

const savedGame = Object.getOwnPropertyDescriptor(globalThis, "game");
const savedCanvas = Object.getOwnPropertyDescriptor(globalThis, "canvas");
const savedFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
const savedLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const savedSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

// Node's test runner owns completion of these registered tests.
void it("projects CSS display dimensions independently of DPR and preload readiness", () => {
  install("display-test");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: () => ({ getBoundingClientRect: () => ({ width: 1920, height: 1080 }) }),
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { devicePixelRatio: 2 },
    });
    Object.assign(canvas!, { ready: true });
    const response = getClientReadiness({ correlationId: "display-test-read" });
    assert.deepEqual(response.display, {
      cssWidth: 1920,
      cssHeight: 1080,
      devicePixelRatio: 2,
      canvasReady: true,
    });
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

function install(clientId = "client-player") {
  let applications = 0;
  let preloads = 0;
  if (typeof globalThis.localStorage === "undefined") {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
  }
  if (globalThis.localStorage.getItem("foundry-local-api.clientId") !== clientId) {
    globalThis.localStorage.setItem("foundry-local-api.clientId", clientId);
  }
  const canvasValue = {
    scene: { id: "scene" },
    stage: { pivot: { x: 0, y: 0 }, scale: { x: 1, y: 1 } },
    animatePan: ({ x, y, scale }: { x?: number; y?: number; scale?: number }) => {
      applications += 1;
      if (x !== undefined) canvasValue.stage.pivot.x = x;
      if (y !== undefined) canvasValue.stage.pivot.y = y;
      if (scale !== undefined) {
        canvasValue.stage.scale.x = scale;
        canvasValue.stage.scale.y = scale;
      }
      return Promise.resolve();
    },
  };
  Object.defineProperty(globalThis, "game", {
    configurable: true,
    value: {
      user: { id: "player" },
      collections: new Map([
        [
          "Scene",
          new Map([
            [
              "scene",
              {
                id: "scene",
                preload: () => {
                  preloads += 1;
                  return Promise.resolve();
                },
              },
            ],
          ]),
        ],
      ]),
    },
  });
  Object.defineProperty(globalThis, "canvas", { configurable: true, value: canvasValue });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => (key === "foundry-local-api.clientId" ? clientId : null),
      setItem: () => undefined,
    },
  });
  return { applications: () => applications, preloads: () => preloads };
}

afterEach(() => {
  for (const [name, descriptor] of [
    ["game", savedGame],
    ["canvas", savedCanvas],
    ["fetch", savedFetch],
    ["localStorage", savedLocalStorage],
    ["sessionStorage", savedSessionStorage],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

void describe("client readiness commands", () => {
  void it("views only the exact receiver and uses DTT pan despite animatePan lock, with durable replay", async () => {
    const fixture = install("forest-tv");
    let physicalPans = 0,
      views = 0;
    Object.assign(game.user, { name: "TV" });
    const viewport = { x: 100, y: 200, scale: 0.5 };
    Object.assign(game, {
      modules: new Map([
        [
          "digital-tabletops",
          {
            active: true,
            api: {
              physicalViewport: () => ({ scale: 0.5 }),
              applyPhysicalViewport: (input: any) => {
                assert.equal(input.expectedScale, 0.5);
                physicalPans++;
                Object.assign(canvas!.stage.pivot, { x: input.x, y: input.y });
                Object.assign(canvas!.stage.scale, { x: 0.5, y: 0.5 });
              },
            },
          },
        ],
      ]),
    });
    game.collections.get("Scene")!.set("forest", {
      id: "forest",
      view: async () => {
        views++;
        Object.assign(canvas!, { scene: { id: "forest" } });
      },
    } as any);
    const input = {
      sceneId: "forest",
      correlationId: "forest-view-dtt-1",
      viewport,
      viewScene: true,
      digitalTabletop: true,
    };
    const response = await applyClientViewport(input);
    assert.equal(response.activeSceneId, "forest");
    assert.equal(response.applied.viewport, true);
    assert.equal(physicalPans, 1);
    assert.equal(views, 1);
    assert.equal(fixture.applications(), 0);
    assert.equal((await applyClientViewport(input)).replayed, true);
    assert.equal(physicalPans, 1);
    assert.equal(views, 1);
  });
  void it("missing DTT or fullscreen preflight refuses before scene view", async () => {
    install("forest-preflight");
    Object.assign(game.user, { name: "TV" });
    let views = 0;
    game.collections.get("Scene")!.set("forest", {
      id: "forest",
      view: async () => {
        views++;
      },
    } as any);
    const input = {
      sceneId: "forest",
      correlationId: "forest-preflight-1",
      viewport: { x: 0, y: 0, scale: 0.5 },
      viewScene: true,
      digitalTabletop: true,
    };
    await assert.rejects(applyClientViewport(input), /Digital Tabletop/);
    Object.assign(game, {
      modules: new Map([
        [
          "digital-tabletops",
          {
            active: true,
            api: {
              physicalViewport: () => {
                throw Error("fullscreen required");
              },
            },
          },
        ],
      ]),
    });
    await assert.rejects(applyClientViewport(input), /fullscreen/);
    assert.equal(views, 0);
  });
  void it("acknowledges a reload before scheduling it and deduplicates correlation replay", () => {
    install();
    let scheduledDelay: number | undefined;
    let scheduled: (() => void) | undefined;
    const schedule = (callback: () => void, delayMs: number) => {
      scheduled = callback;
      scheduledDelay = delayMs;
    };
    const input = { correlationId: "reload-client-0001", delayMs: 1_000 };
    const first = requestClientReload(input, schedule);
    const replay = requestClientReload(input, schedule);
    assert.equal(first.acknowledged, true);
    assert.equal(first.reloadScheduled, true);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(scheduledDelay, 1_000);
    assert.equal(typeof scheduled, "function");
  });

  void it("rejects changed reload input under the same correlation ID", () => {
    install();
    const schedule = () => undefined;
    requestClientReload({ correlationId: "reload-conflict-0001", delayMs: 1_000 }, schedule);
    assert.throws(
      () =>
        requestClientReload({ correlationId: "reload-conflict-0001", delayMs: 2_000 }, schedule),
      (error: unknown) => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT",
    );
  });

  void it("acknowledges preload with per-asset applied state", async () => {
    const state = install();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: (path: string) =>
        Promise.resolve({
          ok: !path.includes("missing"),
          status: path.includes("missing") ? 404 : 200,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)),
        }),
    });
    const value = await preloadClientScene({
      sceneId: "scene",
      assetPaths: ["/ready.png", "/missing.png"],
      correlationId: "preload-ack-0001",
      timeoutMs: 100,
    });
    assert.equal(value.acknowledged, true);
    assert.equal(value.sceneReady, false);
    assert.deepEqual(
      value.assets.map(({ status }) => status),
      ["loaded", "failed"],
    );
    assert.equal(value.applied.preload, true);
    assert.equal(state.preloads(), 1);
    const status = getClientReadiness({ correlationId: "readiness-read-0001" });
    assert.equal(status.assets.length >= 2, true);
  });

  void it("returns actual applied viewport and correlation replay does not double-apply", async () => {
    const state = install();
    const input = {
      sceneId: "scene",
      correlationId: "viewport-ack-0001",
      viewport: { x: 40, y: 50, scale: 1.5 },
    };
    const first = await applyClientViewport(input);
    const replay = await applyClientViewport(input);
    assert.deepEqual(first.viewport, input.viewport);
    assert.equal(first.acknowledged, true);
    assert.equal(replay.replayed, true);
    assert.equal(state.applications(), 1);
  });

  void it("marks acknowledgement incomplete when viewport readback does not match", async () => {
    install();
    (globalThis as any).canvas.animatePan = () => Promise.resolve();
    const value = await applyClientViewport({
      sceneId: "scene",
      correlationId: "viewport-mismatch-0001",
      viewport: { x: 400, y: 500, scale: 2 },
    });
    assert.equal(value.applied.viewport, false);
    assert.equal(value.incomplete, true);
    assert.ok(value.warnings.some((warning) => warning.includes("did not match")));
  });

  void it("reports timeout/asset failure and refuses changed correlation replay", async () => {
    install();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: (_path: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () => reject(new Error("timed out"))),
        ),
    });
    const value = await preloadClientScene({
      sceneId: "scene",
      assetPaths: ["/slow.png"],
      correlationId: "preload-timeout-0001",
      timeoutMs: 5,
    });
    assert.equal(value.assets[0]?.status, "failed");
    await assert.rejects(
      preloadClientScene({
        sceneId: "scene",
        assetPaths: ["/different.png"],
        correlationId: "preload-timeout-0001",
        timeoutMs: 5,
      }),
      (error: unknown) => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT",
    );
  });

  void it("persists correlation replay and readiness across a browser reload", async () => {
    const values = new Map<string, string>([["foundry-local-api.clientId", "client-player"]]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const firstClient = install();
    const input = {
      sceneId: "scene",
      correlationId: "viewport-durable-0001",
      viewport: { x: 12, y: 34, scale: 1.25 },
    };
    await applyClientViewport(input);
    assert.equal(firstClient.applications(), 1);

    // A replacement Storage object models a reloaded module realm reading the
    // same durable browser data.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const reloadedClient = install();
    const replay = await applyClientViewport(input);
    assert.equal(replay.replayed, true);
    assert.equal(reloadedClient.applications(), 0);
  });

  void it("isolates durable acknowledgements between duplicate same-user browser tabs", async () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const input = {
      sceneId: "scene",
      correlationId: "viewport-duplicate-tab-0001",
      viewport: { x: 7, y: 8, scale: 1.1 },
    };
    const firstTab = install("client-tab-one");
    const first = await applyClientViewport(input);
    assert.equal(first.executingClientId, "client-tab-one");
    assert.equal(firstTab.applications(), 1);

    const secondTab = install("client-tab-two");
    const second = await applyClientViewport(input);
    assert.equal(second.replayed, false);
    assert.equal(second.executingClientId, "client-tab-two");
    assert.equal(secondTab.applications(), 1);
  });

  void it("persists intent before mutation and refuses an unknown restart outcome", async () => {
    const values = new Map<string, string>([["foundry-local-api.clientId", "client-player"]]);
    let writes = 0;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          writes += 1;
          if (writes > 1) throw new Error("storage failed after apply");
          values.set(key, value);
        },
      },
    });
    const input = {
      sceneId: "scene",
      correlationId: "viewport-pending-0001",
      viewport: { x: 19, y: 23, scale: 1.4 },
    };
    const firstClient = install();
    await assert.rejects(
      applyClientViewport(input),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
    assert.equal(firstClient.applications(), 1);

    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const restartedClient = install();
    await assert.rejects(
      applyClientViewport(input),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
    assert.equal(restartedClient.applications(), 0, "unknown outcomes are never applied twice");
  });

  void it("fails before mutation when durable storage is unavailable", async () => {
    const state = install();
    Reflect.deleteProperty(globalThis, "localStorage");
    await assert.rejects(
      applyClientViewport({
        sceneId: "scene",
        correlationId: "viewport-no-storage-0001",
        viewport: { x: 3, y: 4, scale: 1.2 },
      }),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
    assert.equal(state.applications(), 0);
  });

  void it("fails visibly without discarding corrupt durable state", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => "{not-json",
        setItem: () => undefined,
      },
    });
    install();
    assert.throws(
      () => getClientReadiness({ correlationId: "readiness-corrupt-0001" }),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
  });
});
