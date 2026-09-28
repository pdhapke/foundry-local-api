import {
  CLIENT_READINESS_COMMANDS,
  ProtocolError,
  type ClientPreloadInput,
  type ClientReadinessInput,
  type ClientReadinessResult,
  type ClientViewportInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";
import { getClientId } from "../bridge-client.js";

const acknowledgements = new Map<string, { input: string; result: ClientReadinessResult }>();
const loadedAssets = new Map<string, "loaded" | "failed">();
let lastPreloadedSceneId: string | null = null;
let hydratedUserId: string | null = null;
let hydratedClientId: string | null = null;
let hydratedStorage: Storage | null = null;

interface DurableReadinessState {
  version: 1;
  userId: string;
  clientId: string;
  acknowledgements: Array<[string, { input: string; result: ClientReadinessResult }]>;
  loadedAssets: Array<[string, "loaded" | "failed"]>;
  lastPreloadedSceneId: string | null;
}

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function storageKey(userId: string, clientId: string): string {
  return `foundry-local-api.client-readiness.v1.${userId}.${clientId}`;
}

function hydrate(): void {
  const storage = browserStorage();
  const clientId = getClientId();
  if (
    hydratedUserId === game.user.id &&
    hydratedClientId === clientId &&
    hydratedStorage === storage
  )
    return;
  acknowledgements.clear();
  loadedAssets.clear();
  lastPreloadedSceneId = null;
  hydratedUserId = game.user.id;
  hydratedClientId = clientId;
  hydratedStorage = storage;
  if (!storage) return;
  const raw = storage.getItem(storageKey(game.user.id, clientId));
  if (!raw) return;
  try {
    const state = JSON.parse(raw) as Partial<DurableReadinessState>;
    if (
      state.version !== 1 ||
      state.userId !== game.user.id ||
      state.clientId !== clientId ||
      !Array.isArray(state.acknowledgements) ||
      !Array.isArray(state.loadedAssets) ||
      (state.lastPreloadedSceneId !== null && typeof state.lastPreloadedSceneId !== "string")
    )
      throw new Error("invalid durable readiness state");
    for (const entry of state.acknowledgements) {
      if (
        !Array.isArray(entry) ||
        typeof entry[0] !== "string" ||
        !entry[1] ||
        typeof entry[1].input !== "string" ||
        entry[1].result?.correlationId !== entry[0] ||
        entry[1].result?.clientUserId !== game.user.id ||
        entry[1].result?.executingClientId !== clientId
      )
        throw new Error("invalid durable acknowledgement");
      acknowledgements.set(entry[0], structuredClone(entry[1]));
    }
    for (const entry of state.loadedAssets) {
      if (
        !Array.isArray(entry) ||
        typeof entry[0] !== "string" ||
        (entry[1] !== "loaded" && entry[1] !== "failed")
      )
        throw new Error("invalid durable asset state");
      loadedAssets.set(entry[0], entry[1]);
    }
    lastPreloadedSceneId = state.lastPreloadedSceneId;
  } catch {
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "Durable client readiness state is corrupt and was not discarded.",
      retryable: false,
    });
  }
}

function persist(): void {
  const storage = browserStorage();
  if (!storage) return;
  const clientId = getClientId();
  const state: DurableReadinessState = {
    version: 1,
    userId: game.user.id,
    clientId,
    acknowledgements: [...acknowledgements],
    loadedAssets: [...loadedAssets],
    lastPreloadedSceneId,
  };
  try {
    storage.setItem(storageKey(game.user.id, clientId), JSON.stringify(state));
  } catch {
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "Client readiness acknowledgement could not be persisted.",
      retryable: true,
    });
  }
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function currentViewport(): ClientReadinessResult["viewport"] {
  if (!canvas) return null;
  return { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
}

function result(
  correlationId: string,
  assets: ClientReadinessResult["assets"],
  applied: ClientReadinessResult["applied"],
  expectedSceneId: string | null,
  scenePreloaded: boolean,
  warnings: string[],
): ClientReadinessResult {
  const activeSceneId = canvas?.scene?.id ?? null;
  const activeSceneMatches = expectedSceneId === null || activeSceneId === expectedSceneId;
  return {
    correlationId,
    acknowledged: true,
    replayed: false,
    acknowledgedAt: new Date().toISOString(),
    clientUserId: game.user.id,
    executingClientId: getClientId(),
    expectedSceneId,
    activeSceneId,
    scenePreloaded,
    activeSceneMatches,
    sceneReady:
      scenePreloaded && activeSceneMatches && assets.every((asset) => asset.status === "loaded"),
    assets,
    viewport: currentViewport(),
    applied,
    warnings,
    incomplete:
      warnings.length > 0 ||
      !activeSceneMatches ||
      assets.some((asset) => asset.status === "failed"),
  };
}

function replayOrThrow(correlationId: string, input: unknown): ClientReadinessResult | undefined {
  hydrate();
  const existing = acknowledgements.get(correlationId);
  if (!existing) return undefined;
  if (existing.input !== encode(input)) {
    throw new ProtocolError({
      code: "IDEMPOTENCY_CONFLICT",
      message: "The client correlation ID was reused with different input.",
      retryable: false,
      fieldPath: "correlationId",
    });
  }
  return { ...structuredClone(existing.result), replayed: true };
}

function remember(correlationId: string, input: unknown, value: ClientReadinessResult): void {
  acknowledgements.set(correlationId, { input: encode(input), result: structuredClone(value) });
  if (acknowledgements.size > 200)
    acknowledgements.delete(acknowledgements.keys().next().value as string);
  persist();
}

async function loadAsset(path: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { cache: "force-cache", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

export async function preloadClientScene(
  input: ClientPreloadInput,
): Promise<ClientReadinessResult> {
  const replay = replayOrThrow(input.correlationId, input);
  if (replay) return replay;
  if (!game.collections.get("Scene")?.has(input.sceneId)) {
    throw new ProtocolError({ code: "NOT_FOUND", message: "Scene not found.", retryable: false });
  }
  const scene = game.collections.get("Scene")?.get(input.sceneId) as
    (FoundryDocument & { preload?: (() => Promise<unknown>) | undefined }) | undefined;
  const sceneCollection = (
    game as unknown as { scenes?: { preload?: (id: string) => Promise<unknown> } }
  ).scenes;
  if (typeof scene?.preload === "function") await scene.preload();
  else if (typeof sceneCollection?.preload === "function")
    await sceneCollection.preload(input.sceneId);
  else {
    throw new ProtocolError({
      code: "UNSUPPORTED_VERSION",
      message: "This Foundry client does not expose a Scene preload API.",
      retryable: false,
    });
  }
  lastPreloadedSceneId = input.sceneId;
  const assets = await Promise.all(
    input.assetPaths.map(async (path) => {
      try {
        await loadAsset(path, input.timeoutMs);
        loadedAssets.set(path, "loaded");
        return { path, status: "loaded" as const };
      } catch (error) {
        loadedAssets.set(path, "failed");
        return {
          path,
          status: "failed" as const,
          error: error instanceof Error ? error.message.slice(0, 200) : "Asset load failed",
        };
      }
    }),
  );
  const warnings =
    canvas?.scene?.id === input.sceneId
      ? []
      : ["The preloaded Scene is not the client's active Scene."];
  const value = result(
    input.correlationId,
    assets,
    { preload: true, viewport: false },
    input.sceneId,
    true,
    warnings,
  );
  remember(input.correlationId, input, value);
  return value;
}

export function getClientReadiness(input: ClientReadinessInput): ClientReadinessResult {
  hydrate();
  const assets = Array.from(loadedAssets, ([path, status]) => ({ path, status }));
  const warnings =
    lastPreloadedSceneId !== null && canvas?.scene?.id !== lastPreloadedSceneId
      ? ["The last preloaded Scene is not the client's active Scene."]
      : [];
  return result(
    input.correlationId,
    assets,
    { preload: false, viewport: false },
    lastPreloadedSceneId,
    lastPreloadedSceneId !== null,
    warnings,
  );
}

export async function applyClientViewport(
  input: ClientViewportInput,
): Promise<ClientReadinessResult> {
  const replay = replayOrThrow(input.correlationId, input);
  if (replay) return replay;
  if (!canvas || canvas.scene?.id !== input.sceneId) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "The requested Scene is not active on this client.",
      retryable: true,
      fieldPath: "sceneId",
    });
  }
  await canvas.animatePan(input.viewport);
  const actual = currentViewport();
  const viewportMatches =
    actual !== null &&
    Math.abs(actual.x - input.viewport.x) <= 0.01 &&
    Math.abs(actual.y - input.viewport.y) <= 0.01 &&
    Math.abs(actual.scale - input.viewport.scale) <= 0.001;
  const warnings = viewportMatches ? [] : ["Applied viewport readback did not match the request."];
  const value = result(
    input.correlationId,
    [],
    { preload: false, viewport: viewportMatches },
    input.sceneId,
    lastPreloadedSceneId === input.sceneId,
    warnings,
  );
  remember(input.correlationId, input, value);
  return value;
}

registerCommand(CLIENT_READINESS_COMMANDS.PRELOAD, preloadClientScene);
registerCommand(CLIENT_READINESS_COMMANDS.GET, getClientReadiness);
registerCommand(CLIENT_READINESS_COMMANDS.APPLY_VIEWPORT, applyClientViewport);
