// Phase 11 — Scenes command handlers. Registered against the same command
// dispatcher registry Phase 2 set up (module/src/command-registry.ts) and
// imported for side effects from module/src/index.ts.
//
// Scene CRUD itself is NOT re-implemented here: it's already covered
// generically by Phase 8's documentList/Get/Create/Update/Delete commands
// with `documentType: "Scene"` (see server/src/endpoints/scenes.ts, which
// calls the same `makeDocumentEndpoints()` factory JournalEntry/Actor/Item
// use). This file only adds the scene-specific extras: activation and
// grid/dimension info (PLAN.md's Phase 11), plus fog-of-war reset (Phase 46).
import {
  ProtocolError,
  SCENE_COMMANDS,
  type DocumentData,
  type SceneGridAlignmentInput,
  type SceneGridAlignmentResult,
  type SceneGridState,
  type SceneDimensions,
  type SceneIdInput,
  type SceneResetFogResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";
import { queryFogDocuments } from "../fog-documents.js";

function requireScene(id: string): FoundryScene {
  const collection = game.collections.get("Scene") as Map<string, FoundryScene> | undefined;
  const scene = collection?.get(id);
  if (!scene) {
    throw new Error(`Scene "${id}" not found`);
  }
  return scene;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Scene source is missing ${field}.`);
  }
  return value as Record<string, unknown>;
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Scene source has an invalid ${field}.`);
  }
  return value;
}

function state(source: Record<string, unknown>): SceneGridState {
  const grid = record(source["grid"], "grid");
  const stats = record(source["_stats"], "_stats");
  return {
    grid: {
      type: number(grid["type"], "grid.type"),
      size: number(grid["size"], "grid.size"),
      distance: number(grid["distance"], "grid.distance"),
      units: String(grid["units"] ?? ""),
      style: String(grid["style"] ?? ""),
      thickness: number(grid["thickness"], "grid.thickness"),
      color: String(grid["color"] ?? ""),
      alpha: number(grid["alpha"], "grid.alpha"),
    },
    shiftX: number(source["shiftX"], "shiftX"),
    shiftY: number(source["shiftY"], "shiftY"),
    modifiedTime: number(stats["modifiedTime"], "_stats.modifiedTime"),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "modifiedTime" && key !== "lastModifiedBy")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function withGrid(
  source: Record<string, unknown>,
  input: Pick<SceneGridAlignmentInput, "size" | "distance" | "shiftX" | "shiftY">,
): Record<string, unknown> {
  const expected = structuredClone(source);
  const grid = record(expected["grid"], "grid");
  grid["size"] = input.size;
  grid["distance"] = input.distance;
  expected["shiftX"] = input.shiftX;
  expected["shiftY"] = input.shiftY;
  return expected;
}

function counts(
  source: Record<string, unknown>,
): SceneGridAlignmentResult["spatialDocumentCounts"] {
  const length = (key: string) => (Array.isArray(source[key]) ? source[key].length : 0);
  return {
    tokens: length("tokens"),
    walls: length("walls"),
    regions: length("regions"),
    tiles: length("tiles"),
    notes: length("notes"),
    lights: length("lights"),
    sounds: length("sounds"),
  };
}

export async function alignSceneGrid(
  input: SceneGridAlignmentInput,
): Promise<SceneGridAlignmentResult> {
  if (!game.user.isGM) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "Scene grid alignment requires an executing GM client.",
      retryable: false,
    });
  }
  const scene = requireScene(input.id);
  const beforeSource = scene.toObject();
  const before = state(beforeSource);
  if (before.modifiedTime !== input.expectedModifiedTime) {
    throw new ProtocolError({
      code: "STALE_REVISION",
      message: "The Scene changed after the alignment payload was prepared.",
      retryable: true,
      fieldPath: "expectedModifiedTime",
      details: { expected: input.expectedModifiedTime, actual: before.modifiedTime },
    });
  }
  const expectedSource = withGrid(beforeSource, input);
  const proposed = state({
    ...expectedSource,
    _stats: { ...record(beforeSource["_stats"], "_stats") },
  });
  const rollback = {
    id: input.id,
    expectedModifiedTime: before.modifiedTime,
    size: before.grid.size,
    distance: before.grid.distance,
    shiftX: before.shiftX,
    shiftY: before.shiftY,
  };
  const spatialDocumentCounts = counts(beforeSource);
  if (input.dryRun) {
    return {
      id: input.id,
      persisted: false,
      before,
      after: proposed,
      rollback,
      spatialDocumentCounts,
      unrelatedSceneFieldsUnchanged: true,
      embeddedDocumentsUnchanged: true,
    };
  }

  await scene.update({
    grid: expectedSource["grid"],
    shiftX: input.shiftX,
    shiftY: input.shiftY,
  });
  const afterSource = scene.toObject();
  const after = state(afterSource);
  const expectedComparable = withGrid(beforeSource, input);
  if (canonical(afterSource) !== canonical(expectedComparable)) {
    await scene.update({ grid: before.grid, shiftX: before.shiftX, shiftY: before.shiftY });
    if (canonical(scene.toObject()) !== canonical(beforeSource)) {
      throw new ProtocolError({
        code: "ROLLBACK_FAILED",
        message:
          "Grid alignment verification failed and the exact prior Scene state was not restored.",
        retryable: false,
      });
    }
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "Grid alignment changed an unrelated Scene field; the prior grid was restored.",
      retryable: false,
    });
  }
  return {
    id: input.id,
    persisted: true,
    before,
    after,
    rollback: { ...rollback, expectedModifiedTime: after.modifiedTime },
    spatialDocumentCounts,
    unrelatedSceneFieldsUnchanged: true,
    embeddedDocumentsUnchanged: true,
  };
}

registerCommand(SCENE_COMMANDS.ACTIVATE, async ({ id }: SceneIdInput): Promise<DocumentData> => {
  const scene = requireScene(id);
  await scene.activate();
  return scene.toObject();
});

const RESET_FOG_TIMEOUT_MS = 10_000;
const RESET_FOG_POLL_MS = 100;

/**
 * Reset explored fog of war for every user (and, on Foundry v14+, every Level) of one Scene.
 *
 * Foundry has no `Scene#resetFog()`; `canvas.fog.reset()` only emits the GM-only `resetFog` socket
 * event for the *viewed* Scene. The server handler deletes every FogExploration for the Scene and
 * broadcasts `resetFog` so connected clients drop their in-memory fog. The event has no
 * acknowledgement, so the result is verified by re-reading the world database until no fog
 * documents remain for the Scene.
 */
export async function resetSceneFog(
  { id }: SceneIdInput,
  { timeoutMs = RESET_FOG_TIMEOUT_MS, pollMs = RESET_FOG_POLL_MS } = {},
): Promise<SceneResetFogResult> {
  if (!game.user.isGM) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "Resetting fog of war requires an executing GM client.",
      retryable: false,
    });
  }
  requireScene(id);
  const before = await queryFogDocuments(id);
  game.socket.emit("resetFog", id);
  const deadline = Date.now() + timeoutMs;
  let remaining = before.length;
  for (;;) {
    remaining = (await queryFogDocuments(id)).length;
    if (remaining === 0 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (remaining > 0) {
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "Foundry did not delete every FogExploration document for the Scene.",
      retryable: true,
      details: { beforeCount: before.length, remainingCount: remaining },
    });
  }
  return { id, deletedDocumentCount: before.length, remainingDocumentCount: 0 };
}

registerCommand(SCENE_COMMANDS.RESET_FOG, (input: SceneIdInput) => resetSceneFog(input));

registerCommand(SCENE_COMMANDS.ALIGN_GRID, alignSceneGrid);

registerCommand(SCENE_COMMANDS.GET_DIMENSIONS, ({ id }: SceneIdInput): SceneDimensions => {
  const scene = requireScene(id);
  return {
    width: scene.width,
    height: scene.height,
    padding: scene.padding,
    size: scene.grid.size,
    gridType: scene.grid.type,
    distance: scene.grid.distance,
    units: scene.grid.units,
    sceneWidth: scene.dimensions.sceneWidth,
    sceneHeight: scene.dimensions.sceneHeight,
    sceneX: scene.dimensions.sceneX,
    sceneY: scene.dimensions.sceneY,
  };
});
