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

type FogDocument = FoundryDocument;

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

function validateTarget({ sceneId, userId }: FogExplorationGetInput): void {
  if (!game.collections.get("Scene")?.has(sceneId)) {
    throw new ProtocolError({ code: "NOT_FOUND", message: "Scene not found.", retryable: false });
  }
  if (!game.users.has(userId)) {
    throw new ProtocolError({ code: "NOT_FOUND", message: "User not found.", retryable: false });
  }
}

function fogDocuments(): FogDocument[] {
  return Array.from(game.collections.get("FogExploration")?.values() ?? []) as FogDocument[];
}

function findFog(sceneId: string, userId: string): FogDocument | undefined {
  return matchingFogDocuments(sceneId, userId)[0];
}

function matchingFogDocuments(sceneId: string, userId: string): FogDocument[] {
  return fogDocuments().filter((document) => {
    const source = document.toObject();
    return source["scene"] === sceneId && source["user"] === userId;
  });
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

async function snapshot(sceneId: string, userId: string): Promise<FogExplorationSnapshot> {
  const matches = matchingFogDocuments(sceneId, userId);
  if (matches.length > 1)
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "Fog exploration is ambiguous for the requested Scene and user.",
      retryable: false,
    });
  const document = matches[0];
  const state = stateOf(document);
  return {
    sceneId,
    userId,
    exists: document !== undefined,
    documentId: document?.id ?? null,
    revision: await revision({ exists: document !== undefined, state }),
    state,
  };
}

const EMPTY_STATE: FogExplorationState = { explored: null, positions: {} };

async function assertExactTarget(
  sceneId: string,
  userId: string,
  expected: { exists: boolean; documentId: string | null; state: FogExplorationState },
): Promise<FogExplorationSnapshot> {
  const matches = matchingFogDocuments(sceneId, userId);
  const actual = await snapshot(sceneId, userId);
  if (
    matches.length !== (expected.exists ? 1 : 0) ||
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

async function compensateFogMutation(
  before: FogExplorationSnapshot,
  beforeSource: Record<string, unknown> | null,
  mutatedDocument: FogDocument | null,
  originalError: unknown,
): Promise<never> {
  try {
    const matches = matchingFogDocuments(before.sceneId, before.userId);
    if (!before.exists) {
      for (const document of matches) await document.delete();
      if (mutatedDocument && !matches.includes(mutatedDocument)) await mutatedDocument.delete();
      await assertExactTarget(before.sceneId, before.userId, {
        exists: false,
        documentId: null,
        state: EMPTY_STATE,
      });
    } else {
      if (!beforeSource || !before.documentId) throw new Error("Missing fog before-image.");
      let original = matches.find((document) => document.id === before.documentId);
      for (const document of matches) {
        if (document.id !== before.documentId) await document.delete();
      }
      if (original) {
        await original.update(beforeSource, { diff: false, recursive: false });
      } else {
        original = await fogDocumentClass().create(beforeSource, { keepId: true });
        if (!original || original.id !== before.documentId)
          throw new Error("Fog recreation did not preserve its document ID.");
      }
      await assertExactTarget(before.sceneId, before.userId, {
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
  validateTarget(input);
  return snapshot(input.sceneId, input.userId);
}

export async function updateFogExploration(
  input: FogExplorationUpdateInput,
): Promise<FogExplorationUpdateResult> {
  requireGm();
  validateTarget(input);
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
  const before = await snapshot(input.sceneId, input.userId);
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
  const existing = findFog(input.sceneId, input.userId);
  const beforeSource = existing?.toObject() ?? null;
  let mutatedDocument: FogDocument | null = null;
  let expected: { exists: boolean; documentId: string | null; state: FogExplorationState };
  try {
    if (input.removeDocument) {
      mutatedDocument = existing ?? null;
      await existing?.delete();
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
        await existing.update({ ...beforeSource, ...next }, { diff: false, recursive: false });
        expected = { exists: true, documentId: existing.id, state: next };
      } else {
        const created = await fogDocumentClass().create({
          scene: input.sceneId,
          user: input.userId,
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
      after: await assertExactTarget(input.sceneId, input.userId, expected),
      mode: input.mode,
      idempotencyKey: input.idempotencyKey,
      replayed: false,
    };
    replays.set(input.idempotencyKey, { input: encodedInput, result: structuredClone(result) });
    if (replays.size > 200) replays.delete(replays.keys().next().value as string);
    return result;
  } catch (error) {
    return compensateFogMutation(before, beforeSource, mutatedDocument, error);
  }
}

registerCommand(FOG_EXPLORATION_COMMANDS.GET, getFogExploration);
registerCommand(FOG_EXPLORATION_COMMANDS.UPDATE, updateFogExploration);
