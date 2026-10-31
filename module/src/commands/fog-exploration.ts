import {
  FOG_EXPLORATION_COMMANDS,
  ProtocolError,
  type FogExplorationGetInput,
  type FogExplorationSnapshot,
  type FogExplorationState,
  type FogExplorationUpdateInput,
  type FogExplorationUpdateResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";
import { fogCollection, fogDatabaseAvailable, queryFogDocuments } from "../fog-documents.js";

type FogDocument = FoundryDocument;

/** A resolved (Scene, user, Level) target. `level` is null on Foundry versions without Scene Levels. */
interface FogTarget {
  sceneId: string;
  userId: string;
  level: string | null;
}

const replays = new Map<string, { input: string; result: FogExplorationUpdateResult }>();

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function revision(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireGm(): void {
  if (!game.user.isGM) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "Only a GM client may inspect or update another user's fog exploration.",
      retryable: false,
    });
  }
}

function sceneLevels(scene: FoundryScene): FoundrySceneLevels | null {
  const levels = scene.levels;
  return levels && typeof levels.has === "function" ? levels : null;
}

/**
 * Foundry v14 keys FogExploration by (Scene, Level, user). Resolve the Level the caller means:
 * an explicit one, else the Scene's only Level, else the Level this GM client is viewing, else the
 * Scene's initial Level. Scenes without Levels (Foundry v13 and earlier) resolve to null.
 */
function resolveLevel(scene: FoundryScene, requested: string | undefined): string | null {
  const levels = sceneLevels(scene);
  if (!levels) {
    if (requested !== undefined) {
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: "This Foundry version has no Scene Levels; omit level.",
        retryable: false,
        fieldPath: "level",
      });
    }
    return null;
  }
  if (requested !== undefined) {
    if (!levels.has(requested)) {
      throw new ProtocolError({
        code: "NOT_FOUND",
        message: "Scene Level not found.",
        retryable: false,
        fieldPath: "level",
      });
    }
    return requested;
  }
  if (levels.size === 1) {
    const only = levels.keys().next().value;
    if (typeof only === "string") return only;
  }
  if (typeof scene._view === "string" && levels.has(scene._view)) return scene._view;
  return scene.initialLevel?.id ?? scene.firstLevel?.id ?? null;
}

function resolveTarget({ sceneId, userId, level }: FogExplorationGetInput): FogTarget {
  const scene = game.collections.get("Scene")?.get(sceneId) as FoundryScene | undefined;
  if (!scene) {
    throw new ProtocolError({ code: "NOT_FOUND", message: "Scene not found.", retryable: false });
  }
  if (!game.users.has(userId)) {
    throw new ProtocolError({ code: "NOT_FOUND", message: "User not found.", retryable: false });
  }
  return { sceneId, userId, level: resolveLevel(scene, level) };
}

function fogDocumentClass(): FoundryDocumentClass {
  const documentClass = CONFIG["FogExploration"]?.documentClass;
  if (!documentClass) {
    throw new ProtocolError({
      code: "HANDLER_ERROR",
      message: "FogExploration document class is unavailable.",
      retryable: false,
    });
  }
  return documentClass;
}

async function matchingFogDocuments(target: FogTarget): Promise<FogDocument[]> {
  const documents = await queryFogDocuments(target.sceneId, target.userId);
  if (target.level === null) return documents;
  return documents.filter((document) => document.toObject()["level"] === target.level);
}

/**
 * Foundry's client database backend applies update/delete responses to the document cached in
 * the world collection and throws when it is missing. Database-fetched fog documents for other
 * users are not cached on a GM client, so cache the instance for the duration of the mutation and
 * drop it afterwards if it was not cached before (mirroring `FogExploration.load`).
 */
async function withCachedDocument<T>(
  document: FogDocument,
  mutate: (live: FogDocument) => Promise<T>,
): Promise<T> {
  const collection = fogDatabaseAvailable() ? fogCollection() : undefined;
  const cached = collection?.get(document.id);
  if (!collection || cached) return mutate(cached ?? document);
  collection.set(document.id, document);
  try {
    return await mutate(document);
  } finally {
    if (collection.get(document.id) === document && document.toObject()["user"] !== game.user.id)
      collection.delete(document.id);
  }
}

async function createFogDocument(
  data: Record<string, unknown>,
  options?: Record<string, unknown>,
): Promise<FogDocument | undefined> {
  const created = await fogDocumentClass().create(data, options);
  // Without a database backend the collection is the only store; keep everything cached.
  const collection = fogDatabaseAvailable() ? fogCollection() : undefined;
  if (
    created &&
    collection &&
    data["user"] !== game.user.id &&
    collection.get(created.id) === created
  )
    collection.delete(created.id);
  return created;
}

function stateOf(document: FogDocument | undefined): FogExplorationState {
  const source = document?.toObject() ?? {};
  const positions = source["positions"];
  return {
    explored: typeof source["explored"] === "string" ? source["explored"] : null,
    positions:
      typeof positions === "object" && positions !== null
        ? structuredClone(positions as FogExplorationState["positions"])
        : {},
  };
}

async function snapshotOf(
  target: FogTarget,
  matches: FogDocument[],
): Promise<FogExplorationSnapshot> {
  if (matches.length > 1)
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "Fog exploration is ambiguous for the requested Scene, Level, and user.",
      retryable: false,
      details: { matchingDocumentCount: matches.length },
    });
  const document = matches[0];
  const state = stateOf(document);
  const exists = document !== undefined;
  return {
    sceneId: target.sceneId,
    userId: target.userId,
    level: target.level,
    exists,
    documentId: document?.id ?? null,
    // Pre-Levels revisions are unchanged; v14 revisions also bind the Level.
    revision: await revision(
      target.level === null ? { exists, state } : { exists, state, level: target.level },
    ),
    state,
  };
}

async function snapshot(target: FogTarget): Promise<FogExplorationSnapshot> {
  return snapshotOf(target, await matchingFogDocuments(target));
}

const EMPTY_STATE: FogExplorationState = { explored: null, positions: {} };

async function assertExactTarget(
  target: FogTarget,
  expected: { exists: boolean; documentId: string | null; state: FogExplorationState },
): Promise<FogExplorationSnapshot> {
  const matches = await matchingFogDocuments(target);
  if (matches.length !== (expected.exists ? 1 : 0)) {
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "Foundry fog exploration did not match the exact requested post-write state.",
      retryable: false,
      details: {
        expectedExists: expected.exists,
        matchingDocumentCount: matches.length,
      },
    });
  }
  const actual = await snapshotOf(target, matches);
  if (
    actual.exists !== expected.exists ||
    actual.documentId !== expected.documentId ||
    stable(actual.state) !== stable(expected.state)
  ) {
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "Foundry fog exploration did not match the exact requested post-write state.",
      retryable: false,
      details: {
        expectedExists: expected.exists,
        actualExists: actual.exists,
        expectedDocumentId: expected.documentId,
        actualDocumentId: actual.documentId,
        matchingDocumentCount: matches.length,
      },
    });
  }
  return actual;
}

async function compensateFogMutation(
  target: FogTarget,
  before: FogExplorationSnapshot,
  beforeSource: Record<string, unknown> | null,
  mutatedDocument: FogDocument | null,
  originalError: unknown,
): Promise<never> {
  try {
    const matches = await matchingFogDocuments(target);
    if (!before.exists) {
      for (const document of matches) await withCachedDocument(document, (live) => live.delete());
      if (mutatedDocument && !matches.some((document) => document.id === mutatedDocument.id)) {
        const stillPresent = (await queryFogDocuments(target.sceneId, target.userId)).find(
          (document) => document.id === mutatedDocument.id,
        );
        if (stillPresent) await withCachedDocument(stillPresent, (live) => live.delete());
      }
      await assertExactTarget(target, { exists: false, documentId: null, state: EMPTY_STATE });
    } else {
      if (!beforeSource || !before.documentId) throw new Error("Missing fog before-image.");
      let original = matches.find((document) => document.id === before.documentId);
      for (const document of matches) {
        if (document.id !== before.documentId)
          await withCachedDocument(document, (live) => live.delete());
      }
      if (original) {
        await withCachedDocument(original, (live) =>
          live.update(beforeSource, { diff: false, recursive: false }),
        );
      } else {
        original = await createFogDocument(beforeSource, { keepId: true });
        if (!original || original.id !== before.documentId)
          throw new Error("Fog recreation did not preserve its document ID.");
      }
      await assertExactTarget(target, {
        exists: true,
        documentId: before.documentId,
        state: before.state,
      });
    }
  } catch (rollbackError) {
    throw new ProtocolError({
      code: "ROLLBACK_FAILED",
      message: "Fog exploration post-write verification failed and exact restoration failed.",
      retryable: false,
      details: {
        originalCode: originalError instanceof ProtocolError ? originalError.code : "HANDLER_ERROR",
        rollbackCode: rollbackError instanceof ProtocolError ? rollbackError.code : "HANDLER_ERROR",
      },
    });
  }
  throw originalError;
}

function assertState(state: Partial<FogExplorationState>): void {
  if (
    state.explored !== undefined &&
    state.explored !== null &&
    typeof state.explored !== "string"
  ) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "explored must be a string or null.",
      retryable: false,
      fieldPath: "state.explored",
    });
  }
  if (
    state.positions !== undefined &&
    (typeof state.positions !== "object" || state.positions === null)
  ) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "positions must be an object.",
      retryable: false,
      fieldPath: "state.positions",
    });
  }
}

export async function getFogExploration(
  input: FogExplorationGetInput,
): Promise<FogExplorationSnapshot> {
  requireGm();
  return snapshot(resolveTarget(input));
}

export async function updateFogExploration(
  input: FogExplorationUpdateInput,
): Promise<FogExplorationUpdateResult> {
  requireGm();
  const target = resolveTarget(input);
  assertState(input.state);
  if (input.mode === "merge" && Object.hasOwn(input.state, "explored")) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message:
        "Binary explored texture data cannot be safely union-merged; merge accepts positions only. Use replace for explored texture state.",
      retryable: false,
      fieldPath: "state.explored",
    });
  }
  const encodedInput = stable(input);
  const replay = replays.get(input.idempotencyKey);
  if (replay) {
    if (replay.input !== encodedInput) {
      throw new ProtocolError({
        code: "IDEMPOTENCY_CONFLICT",
        message: "The fog idempotency key was used with different input.",
        retryable: false,
        fieldPath: "idempotencyKey",
      });
    }
    return { ...structuredClone(replay.result), replayed: true };
  }
  const matches = await matchingFogDocuments(target);
  const before = await snapshotOf(target, matches);
  if (before.revision !== input.expectedRevision) {
    throw new ProtocolError({
      code: "STALE_REVISION",
      message: "Fog exploration changed after it was read.",
      retryable: true,
      fieldPath: "expectedRevision",
      details: { expected: input.expectedRevision, actual: before.revision },
    });
  }
  if (
    input.removeDocument &&
    (input.mode !== "replace" ||
      (input.state.explored ?? null) !== null ||
      Object.keys(input.state.positions ?? {}).length > 0)
  ) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "removeDocument requires replace mode and an empty fog state.",
      retryable: false,
      fieldPath: "removeDocument",
    });
  }
  const existing = matches[0];
  const beforeSource = existing?.toObject() ?? null;
  let mutatedDocument: FogDocument | null = null;
  let expected: { exists: boolean; documentId: string | null; state: FogExplorationState };
  try {
    if (input.removeDocument) {
      mutatedDocument = existing ?? null;
      if (existing) await withCachedDocument(existing, (live) => live.delete());
      expected = { exists: false, documentId: null, state: EMPTY_STATE };
    } else {
      const next: FogExplorationState =
        input.mode === "replace"
          ? { explored: input.state.explored ?? null, positions: input.state.positions ?? {} }
          : {
              explored: before.state.explored,
              positions: { ...before.state.positions, ...(input.state.positions ?? {}) },
            };
      if (existing) {
        mutatedDocument = existing;
        await withCachedDocument(existing, (live) =>
          live.update({ ...beforeSource, ...next }, { diff: false, recursive: false }),
        );
        expected = { exists: true, documentId: existing.id, state: next };
      } else {
        const created = await createFogDocument({
          scene: target.sceneId,
          user: target.userId,
          ...(target.level === null ? {} : { level: target.level }),
          ...next,
        });
        if (!created) {
          throw new ProtocolError({
            code: "HANDLER_ERROR",
            message: "Foundry did not create the FogExploration document.",
            retryable: false,
          });
        }
        mutatedDocument = created;
        expected = { exists: true, documentId: created.id, state: next };
      }
    }
    const result: FogExplorationUpdateResult = {
      before,
      after: await assertExactTarget(target, expected),
      mode: input.mode,
      idempotencyKey: input.idempotencyKey,
      replayed: false,
    };
    replays.set(input.idempotencyKey, { input: encodedInput, result: structuredClone(result) });
    if (replays.size > 200) replays.delete(replays.keys().next().value as string);
    return result;
  } catch (error) {
    return compensateFogMutation(target, before, beforeSource, mutatedDocument, error);
  }
}

registerCommand(FOG_EXPLORATION_COMMANDS.GET, getFogExploration);
registerCommand(FOG_EXPLORATION_COMMANDS.UPDATE, updateFogExploration);
