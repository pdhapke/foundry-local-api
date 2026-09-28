import {
  EMBEDDED_CHILD_COMMANDS,
  ProtocolError,
  assertIdempotencyKey,
  type EmbeddedChildCreateInput,
  type EmbeddedChildDeleteInput,
  type EmbeddedChildDiffEntry,
  type EmbeddedChildFamily,
  type EmbeddedChildIdInput,
  type EmbeddedChildListResult,
  type EmbeddedChildMutationResult,
  type EmbeddedChildParentInput,
  type EmbeddedChildReadResult,
  type EmbeddedChildUpdateInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";
import { validateDocumentSchema } from "./schema-discovery.js";

interface EmbeddedParent extends FoundryDocument {
  canUserModify?: ((user: unknown, action: "update") => boolean) | undefined;
  getEmbeddedCollection(type: string): Map<string, FoundryDocument>;
  createEmbeddedDocuments(
    type: string,
    data: Record<string, unknown>[],
    options?: Record<string, unknown>,
  ): Promise<FoundryDocument[]>;
}

const PARENT_TYPES: Record<EmbeddedChildFamily, string> = {
  Tile: "Scene",
  RegionBehavior: "Region",
  PlaylistSound: "Playlist",
  TableResult: "RollTable",
  Card: "Cards",
};
const replayCache = new Map<string, { fingerprint: string; result: EmbeddedChildMutationResult }>();

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "_stats")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function exactCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(exactCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, exactCanonical(child)]),
    );
  }
  return value;
}

function exactSourceEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(exactCanonical(left)) === JSON.stringify(exactCanonical(right));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const REDACTED_SOURCE_KEYS = new Set([
  "stats",
  "ownership",
  "permission",
  "apikey",
  "credential",
  "credentials",
  "authorization",
  "cookie",
  "cookies",
  "password",
  "privatekey",
]);

function normalizedSourceKey(key: string): string {
  return key
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function sourceKeyIsSecret(key: string): boolean {
  const normalized = normalizedSourceKey(key);
  return (
    REDACTED_SOURCE_KEYS.has(normalized) ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("authorization") ||
    normalized.includes("credential") ||
    normalized.endsWith("apikey") ||
    normalized.includes("privatekey") ||
    normalized.startsWith("session") ||
    normalized.endsWith("session")
  );
}

/** Removes transport, permission, and module-internal metadata from command results. */
function projectSource(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => projectSource(entry));
  if (!isRecord(value)) return clone(value);
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      if (sourceKeyIsSecret(key)) return [];
      if (parentKey === "foundry-local-api" && key === "idempotencyKey") return [];
      return [[key, projectSource(child, key)]];
    }),
  );
}

function projectedRecord(value: Record<string, unknown>): Record<string, unknown> {
  return projectSource(value) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeCandidate(
  before: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const merged = clone(before);
  for (const [key, value] of Object.entries(changes)) {
    merged[key] =
      isRecord(value) && isRecord(merged[key]) ? mergeCandidate(merged[key], value) : clone(value);
  }
  return merged;
}

function structuredDiff(before: unknown, after: unknown, path = "$"): EmbeddedChildDiffEntry[] {
  if (JSON.stringify(canonical(before)) === JSON.stringify(canonical(after))) return [];
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => {
      const childPath = path === "$" ? key : `${path}.${key}`;
      if (!(key in before))
        return [{ path: childPath, kind: "added" as const, after: clone(after[key]) }];
      if (!(key in after))
        return [{ path: childPath, kind: "removed" as const, before: clone(before[key]) }];
      return structuredDiff(before[key], after[key], childPath);
    });
  }
  return [{ path, kind: "changed", before: clone(before), after: clone(after) }];
}

async function revision(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireWorldDocument(type: string, id: string): FoundryDocument {
  const document = game.collections.get(type)?.get(id);
  if (!document) {
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: `${type} "${id}" was not found.`,
      retryable: false,
      fieldPath: "parentId",
    });
  }
  return document;
}

function resolveParent(input: EmbeddedChildParentInput): EmbeddedParent {
  if (input.family === "RegionBehavior") {
    if (
      typeof input.sceneId !== "string" ||
      input.sceneId.length < 1 ||
      input.sceneId.length > 128 ||
      input.sceneId.trim() !== input.sceneId
    ) {
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: "RegionBehavior operations require an exact non-blank Scene ID.",
        retryable: false,
        fieldPath: "sceneId",
      });
    }
    const scene = requireWorldDocument("Scene", input.sceneId) as EmbeddedParent;
    const region = scene.getEmbeddedCollection("Region").get(input.parentId) as
      EmbeddedParent | undefined;
    if (!region) {
      throw new ProtocolError({
        code: "NOT_FOUND",
        message: `Region "${input.parentId}" was not found on the selected Scene.`,
        retryable: false,
        fieldPath: "parentId",
      });
    }
    return region;
  }
  return requireWorldDocument(PARENT_TYPES[input.family], input.parentId) as EmbeddedParent;
}

function assertWritable(parent: EmbeddedParent): void {
  if (!parent.canUserModify?.(game.user, "update")) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "The executing Foundry user cannot modify this embedded collection.",
      retryable: false,
    });
  }
}

function assertReadable(document: FoundryDocument): void {
  const candidate = document as FoundryDocument & {
    testUserPermission?: (user: unknown, permission: string) => boolean;
  };
  if (
    !(game.user as unknown as { isGM?: boolean }).isGM &&
    !candidate.testUserPermission?.(game.user, "OBSERVER")
  ) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "The executing Foundry user cannot inspect this document.",
      retryable: false,
    });
  }
}

async function replayKey(
  operation: string,
  input: { idempotencyKey: string },
  payload: unknown,
): Promise<{ key: string; fingerprint: string; prior?: EmbeddedChildMutationResult }> {
  const key = `${operation}:${input.idempotencyKey}`;
  const fingerprint = await revision(payload);
  const cached = replayCache.get(key);
  if (cached && cached.fingerprint !== fingerprint)
    throw new ProtocolError({
      code: "IDEMPOTENCY_CONFLICT",
      message: "The idempotency key was already used for a different embedded mutation.",
      retryable: false,
      fieldPath: "idempotencyKey",
    });
  return { key, fingerprint, ...(cached ? { prior: { ...cached.result, replayed: true } } : {}) };
}

function child(parent: EmbeddedParent, family: EmbeddedChildFamily, id: string): FoundryDocument {
  const result = parent.getEmbeddedCollection(family).get(id);
  if (!result) {
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: `${family} "${id}" was not found on its parent.`,
      retryable: false,
      fieldPath: "childId",
    });
  }
  return result;
}

async function assertRevision(expected: string, value: unknown, fieldPath: string): Promise<void> {
  const actual = await revision(value);
  if (expected !== actual) {
    throw new ProtocolError({
      code: "STALE_REVISION",
      message: "The embedded mutation target changed after it was read.",
      retryable: true,
      fieldPath,
      details: { expected, actual },
    });
  }
}

function validate(
  family: EmbeddedChildFamily,
  data: Record<string, unknown>,
  mode: "create" | "update",
): {
  normalized: Record<string, unknown>;
  subtype?: string;
  warnings: Array<{ code: string; path: string; message: string }>;
  migrationWarnings: string[];
} {
  let subtype: string | undefined;
  if (family === "RegionBehavior") {
    if (typeof data["type"] !== "string" || data["type"].length === 0) {
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: "RegionBehavior data requires an exact registered behavior type.",
        retryable: false,
        fieldPath: mode === "create" ? "data.type" : "changes.type",
      });
    }
    subtype = data["type"];
    const configured = (
      CONFIG as unknown as {
        RegionBehavior?: { dataModels?: Record<string, unknown> | Map<string, unknown> };
      }
    ).RegionBehavior?.dataModels;
    const registered =
      configured instanceof Map
        ? configured.has(subtype)
        : Boolean(configured && Object.prototype.hasOwnProperty.call(configured, subtype));
    if (!registered) {
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: `RegionBehavior subtype "${subtype}" is not registered by this runtime.`,
        retryable: false,
        fieldPath: mode === "create" ? "data.type" : "changes.type",
        details: { subtype },
      });
    }
  }
  const result = validateDocumentSchema({
    documentType: family,
    parentDocumentType: PARENT_TYPES[family],
    ...(subtype ? { subtype } : {}),
    expectedFoundryVersion: game.release.version,
    expectedSystemId: game.system.id,
    expectedSystemVersion: game.system.version,
    mode: family === "RegionBehavior" ? "create" : mode,
    data,
  });
  const candidate = result.results[0];
  if (!candidate?.valid) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: `Invalid ${family} data.`,
      retryable: false,
      fieldPath: mode === "create" ? "data" : "changes",
      details: { errors: candidate?.errors ?? [], warnings: candidate?.warnings ?? [] },
    });
  }
  return {
    normalized: candidate.normalized,
    ...(subtype ? { subtype } : {}),
    warnings: candidate.warnings.map(({ code, path, message }) => ({ code, path, message })),
    migrationWarnings: candidate.migrationWarnings,
  };
}

function resultMetadata(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  validation?: ReturnType<typeof validate>,
  dryRun = false,
) {
  const projectedBefore = before ? projectedRecord(before) : null;
  const projectedAfter = after ? projectedRecord(after) : null;
  return {
    dryRun,
    persisted: !dryRun,
    ...(validation?.subtype ? { subtype: validation.subtype } : {}),
    before: projectedBefore,
    after: projectedAfter,
    diff: structuredDiff(projectedBefore, projectedAfter),
    warnings: validation?.warnings ?? [],
    migrationWarnings: validation?.migrationWarnings ?? [],
  };
}

async function assertExactSource(
  actual: FoundryDocument,
  expected: Record<string, unknown>,
): Promise<void> {
  if ((await revision(actual.toObject())) !== (await revision(expected))) {
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "Foundry persisted a different embedded child source than the validated candidate.",
      retryable: false,
    });
  }
}

async function collectionSnapshot(
  parent: EmbeddedParent,
  family: EmbeddedChildFamily,
  excludedId?: string,
): Promise<Map<string, Record<string, unknown>>> {
  const entries = [...parent.getEmbeddedCollection(family).entries()].filter(
    ([id]) => id !== excludedId,
  );
  return new Map(entries.map(([id, document]) => [id, clone(document.toObject())]));
}

async function assertSiblings(
  parent: EmbeddedParent,
  family: EmbeddedChildFamily,
  before: Map<string, Record<string, unknown>>,
  excludedId?: string,
): Promise<void> {
  const after = await collectionSnapshot(parent, family, excludedId);
  const beforeSources = [...before].sort(([left], [right]) => left.localeCompare(right));
  const afterSources = [...after].sort(([left], [right]) => left.localeCompare(right));
  if (
    beforeSources.length !== afterSources.length ||
    beforeSources.some(
      ([id, source], index) =>
        afterSources[index]?.[0] !== id || !exactSourceEqual(source, afterSources[index]?.[1]),
    )
  ) {
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "An unrelated embedded sibling changed during the targeted mutation.",
      retryable: false,
    });
  }
}

async function restoreCollection(
  parent: EmbeddedParent,
  family: EmbeddedChildFamily,
  before: Map<string, Record<string, unknown>>,
  originalError: unknown,
): Promise<void> {
  try {
    const collection = parent.getEmbeddedCollection(family);
    for (const [id, document] of [...collection]) {
      if (!before.has(id)) await document.delete();
    }
    for (const [id, source] of before) {
      const existing = collection.get(id);
      if (existing) {
        if (!exactSourceEqual(existing.toObject(), source)) {
          await existing.update(clone(source), { diff: false, recursive: false });
        }
      } else {
        await parent.createEmbeddedDocuments(family, [clone(source)], { keepId: true });
      }
    }
    const expectedOrder = [...before.keys()];
    const actualOrder = [...collection.keys()];
    if (
      expectedOrder.length !== actualOrder.length ||
      expectedOrder.some((id, index) => actualOrder[index] !== id)
    ) {
      for (const document of [...collection.values()]) await document.delete();
      if (before.size > 0) {
        await parent.createEmbeddedDocuments(family, [...before.values()].map(clone), {
          keepId: true,
        });
      }
    }
    await assertSiblings(parent, family, before);
  } catch (rollbackError) {
    const safeErrorCode = (error: unknown): string =>
      error instanceof ProtocolError ? error.code : "UNEXPECTED_ERROR";
    throw new ProtocolError({
      code: "ROLLBACK_FAILED",
      message: `Failed to restore the complete ${family} collection after verification failed.`,
      retryable: false,
      details: {
        originalErrorCode: safeErrorCode(originalError),
        rollbackErrorCode: safeErrorCode(rollbackError),
      },
    });
  }
}

async function restoreMutationState(
  parent: EmbeddedParent,
  family: EmbeddedChildFamily,
  collectionBefore: Map<string, Record<string, unknown>>,
  regionBefore: Record<string, unknown> | undefined,
  originalError: unknown,
): Promise<void> {
  let rollbackPhase = "parent";
  try {
    if (regionBefore) {
      await parent.update(clone(regionBefore), { diff: false, recursive: false });
    }
    rollbackPhase = "children";
    await restoreCollection(parent, family, collectionBefore, originalError);
    rollbackPhase = "verification";
    if (regionBefore && !exactSourceEqual(parent.toObject(), regionBefore)) {
      throw new Error("The complete Region source differs from its pre-mutation snapshot.");
    }
  } catch (rollbackError) {
    if (rollbackError instanceof ProtocolError && rollbackError.code === "ROLLBACK_FAILED") {
      throw rollbackError;
    }
    throw new ProtocolError({
      code: "ROLLBACK_FAILED",
      message: `Failed to restore the complete ${family} parent and child state.`,
      retryable: false,
      details: {
        originalErrorCode:
          originalError instanceof ProtocolError ? originalError.code : "UNEXPECTED_ERROR",
        rollbackErrorCode:
          rollbackError instanceof ProtocolError ? rollbackError.code : "UNEXPECTED_ERROR",
        rollbackPhase,
      },
    });
  }
}

function compensatedFailure(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) {
    return new ProtocolError({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.fieldPath ? { fieldPath: error.fieldPath } : {}),
      ...(error.correlationId ? { correlationId: error.correlationId } : {}),
      details: {
        ...(error.details ?? {}),
        compensationVerified: true,
        persistentPartialSuccess: false,
      },
    });
  }
  return new ProtocolError({
    code: "INCOMPLETE_RESULT",
    message: "The embedded mutation failed and its prior state was restored.",
    retryable: false,
    details: {
      compensationVerified: true,
      persistentPartialSuccess: false,
    },
  });
}

function unrelatedRegionSource(
  parent: EmbeddedParent,
  family: EmbeddedChildFamily,
): Record<string, unknown> | undefined {
  if (family !== "RegionBehavior") return undefined;
  const source = clone(parent.toObject());
  const embedded = (
    CONFIG as unknown as {
      Region?: {
        documentClass?: { metadata?: { embedded?: Record<string, string> | Map<string, string> } };
      };
    }
  ).Region?.documentClass?.metadata?.embedded;
  const collectionKey =
    embedded instanceof Map ? embedded.get("RegionBehavior") : embedded?.["RegionBehavior"];
  delete source[collectionKey ?? "behaviors"];
  return source;
}

async function assertRegionUnchanged(
  parent: EmbeddedParent,
  before: Record<string, unknown> | undefined,
): Promise<void> {
  if (!before) return;
  const after = unrelatedRegionSource(parent, "RegionBehavior");
  if ((await revision(before)) !== (await revision(after))) {
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "An unrelated Region field changed during the RegionBehavior mutation.",
      retryable: false,
    });
  }
}

async function readResult(
  input: EmbeddedChildIdInput,
  parent: EmbeddedParent,
  document: FoundryDocument,
): Promise<EmbeddedChildReadResult> {
  const data = document.toObject();
  return {
    family: input.family,
    parentId: input.parentId,
    childId: document.id,
    parentRevision: await revision(parent.toObject()),
    childRevision: await revision(data),
    data: projectedRecord(data),
  };
}

registerCommand(
  EMBEDDED_CHILD_COMMANDS.LIST,
  async (input: EmbeddedChildParentInput): Promise<EmbeddedChildListResult> => {
    const parent = resolveParent(input);
    assertReadable(parent);
    const children = await Promise.all(
      [...parent.getEmbeddedCollection(input.family).values()].map(async (document) => {
        assertReadable(document);
        const data = document.toObject();
        return {
          childId: document.id,
          revision: await revision(data),
          data: projectedRecord(data),
        };
      }),
    );
    return {
      family: input.family,
      parentId: input.parentId,
      parentRevision: await revision(parent.toObject()),
      children,
    };
  },
);

registerCommand(
  EMBEDDED_CHILD_COMMANDS.GET,
  async (input: EmbeddedChildIdInput): Promise<EmbeddedChildReadResult> => {
    const parent = resolveParent(input);
    assertReadable(parent);
    const target = child(parent, input.family, input.childId);
    assertReadable(target);
    return readResult(input, parent, target);
  },
);

registerCommand(
  EMBEDDED_CHILD_COMMANDS.CREATE,
  async (input: EmbeddedChildCreateInput): Promise<EmbeddedChildMutationResult> => {
    assertIdempotencyKey(input.idempotencyKey);
    const replay = await replayKey("create", input, input);
    if (replay.prior) return replay.prior;
    const parent = resolveParent(input);
    assertWritable(parent);
    await assertRevision(input.expectedParentRevision, parent.toObject(), "expectedParentRevision");
    const existing = parent.getEmbeddedCollection(input.family).get(input.data._id);
    if (existing) {
      const flags = existing.toObject()["flags"] as Record<string, unknown> | undefined;
      const moduleFlags = flags?.["foundry-local-api"] as Record<string, unknown> | undefined;
      if (moduleFlags?.["idempotencyKey"] === input.idempotencyKey) {
        const data = existing.toObject();
        const validation = validate(input.family, input.data, "create");
        return {
          ...(await readResult({ ...input, childId: existing.id }, parent, existing)),
          replayed: true,
          ...resultMetadata(null, data, validation),
          siblingsVerified: true,
          siblingCount: parent.getEmbeddedCollection(input.family).size - 1,
        };
      }
      throw new ProtocolError({
        code: "IDEMPOTENCY_CONFLICT",
        message: "The requested stable child ID already exists.",
        retryable: false,
        fieldPath: "data._id",
      });
    }
    const collectionBefore = await collectionSnapshot(parent, input.family);
    const siblings = await collectionSnapshot(parent, input.family);
    const regionBefore = unrelatedRegionSource(parent, input.family);
    const completeRegionBefore =
      input.family === "RegionBehavior" ? clone(parent.toObject()) : undefined;
    const validation = validate(input.family, input.data, "create");
    const normalized = validation.normalized;
    const sourceFlags = (normalized["flags"] as Record<string, unknown> | undefined) ?? {};
    normalized["flags"] = {
      ...sourceFlags,
      "foundry-local-api": {
        ...((sourceFlags["foundry-local-api"] as Record<string, unknown> | undefined) ?? {}),
        idempotencyKey: input.idempotencyKey,
      },
    };
    const preview = { ...normalized, _id: input.data._id };
    if (input.dryRun === true) {
      return {
        family: input.family,
        parentId: input.parentId,
        childId: input.data._id,
        parentRevision: await revision(parent.toObject()),
        childRevision: await revision(preview),
        data: projectedRecord(preview),
        replayed: false,
        ...resultMetadata(null, preview, validation, true),
        siblingsVerified: true,
        siblingCount: siblings.size,
      };
    }
    let created: FoundryDocument | undefined;
    try {
      [created] = await parent.createEmbeddedDocuments(
        input.family,
        [{ ...normalized, _id: input.data._id }],
        { keepId: true },
      );
      if (!created)
        throw new ProtocolError({
          code: "INCOMPLETE_RESULT",
          message: `Foundry did not return the created ${input.family}.`,
          retryable: false,
        });
      await assertExactSource(created, preview);
      await assertSiblings(parent, input.family, siblings, created.id);
      await assertRegionUnchanged(parent, regionBefore);
      const data = created.toObject();
      const result = {
        ...(await readResult({ ...input, childId: created.id }, parent, created)),
        replayed: false,
        ...resultMetadata(null, data, validation),
        siblingsVerified: true as const,
        siblingCount: siblings.size,
      };
      replayCache.set(replay.key, { fingerprint: replay.fingerprint, result });
      return result;
    } catch (error) {
      await restoreMutationState(
        parent,
        input.family,
        collectionBefore,
        completeRegionBefore,
        error,
      );
      throw compensatedFailure(error);
    }
  },
);

registerCommand(
  EMBEDDED_CHILD_COMMANDS.UPDATE,
  async (input: EmbeddedChildUpdateInput): Promise<EmbeddedChildMutationResult> => {
    assertIdempotencyKey(input.idempotencyKey);
    const replay = await replayKey("update", input, input);
    if (replay.prior) return replay.prior;
    const parent = resolveParent(input);
    assertWritable(parent);
    const target = child(parent, input.family, input.childId);
    await assertRevision(input.expectedParentRevision, parent.toObject(), "expectedParentRevision");
    await assertRevision(input.expectedChildRevision, target.toObject(), "expectedChildRevision");
    const before = target.toObject();
    const collectionBefore = await collectionSnapshot(parent, input.family);
    const siblings = await collectionSnapshot(parent, input.family, target.id);
    const regionBefore = unrelatedRegionSource(parent, input.family);
    const completeRegionBefore =
      input.family === "RegionBehavior" ? clone(parent.toObject()) : undefined;
    const candidate = mergeCandidate(before, input.changes);
    const validation = validate(input.family, candidate, "update");
    const normalized = validation.normalized;
    if (input.dryRun === true) {
      return {
        family: input.family,
        parentId: input.parentId,
        childId: target.id,
        parentRevision: await revision(parent.toObject()),
        childRevision: await revision(normalized),
        data: projectedRecord(normalized),
        replayed: false,
        ...resultMetadata(before, normalized, validation, true),
        siblingsVerified: true,
        siblingCount: siblings.size,
      };
    }
    try {
      await target.update(normalized);
      await assertExactSource(target, normalized);
      await assertSiblings(parent, input.family, siblings, target.id);
      await assertRegionUnchanged(parent, regionBefore);
      const after = target.toObject();
      const result = {
        ...(await readResult(input, parent, target)),
        replayed: false,
        ...resultMetadata(before, after, validation),
        siblingsVerified: true as const,
        siblingCount: siblings.size,
      };
      replayCache.set(replay.key, { fingerprint: replay.fingerprint, result });
      return result;
    } catch (error) {
      await restoreMutationState(
        parent,
        input.family,
        collectionBefore,
        completeRegionBefore,
        error,
      );
      throw compensatedFailure(error);
    }
  },
);

registerCommand(
  EMBEDDED_CHILD_COMMANDS.DELETE,
  async (input: EmbeddedChildDeleteInput): Promise<EmbeddedChildMutationResult> => {
    assertIdempotencyKey(input.idempotencyKey);
    const replay = await replayKey("delete", input, input);
    if (replay.prior) return replay.prior;
    const parent = resolveParent(input);
    assertWritable(parent);
    const target = parent.getEmbeddedCollection(input.family).get(input.childId);
    if (!target) {
      const result: EmbeddedChildMutationResult = {
        family: input.family,
        parentId: input.parentId,
        childId: input.childId,
        parentRevision: await revision(parent.toObject()),
        childRevision: input.expectedChildRevision,
        data: {},
        replayed: false,
        ...resultMetadata(null, null, undefined, input.dryRun === true),
        persisted: false,
        deleted: false,
        alreadyAbsent: true,
        siblingsVerified: true,
        siblingCount: parent.getEmbeddedCollection(input.family).size,
      };
      replayCache.set(replay.key, { fingerprint: replay.fingerprint, result });
      return result;
    }
    const data = target.toObject();
    await assertRevision(input.expectedParentRevision, parent.toObject(), "expectedParentRevision");
    await assertRevision(input.expectedChildRevision, data, "expectedChildRevision");
    const collectionBefore = await collectionSnapshot(parent, input.family);
    const siblings = await collectionSnapshot(parent, input.family, target.id);
    const regionBefore = unrelatedRegionSource(parent, input.family);
    const completeRegionBefore =
      input.family === "RegionBehavior" ? clone(parent.toObject()) : undefined;
    if (input.dryRun === true) {
      return {
        family: input.family,
        parentId: input.parentId,
        childId: input.childId,
        parentRevision: await revision(parent.toObject()),
        childRevision: await revision(data),
        data: projectedRecord(data),
        replayed: false,
        ...resultMetadata(data, null, undefined, true),
        deleted: true,
        siblingsVerified: true,
        siblingCount: siblings.size,
      };
    }
    try {
      await target.delete();
      if (parent.getEmbeddedCollection(input.family).has(target.id))
        throw new ProtocolError({
          code: "INCOMPLETE_RESULT",
          message: `Foundry did not delete the ${input.family}.`,
          retryable: false,
        });
      await assertSiblings(parent, input.family, siblings);
      await assertRegionUnchanged(parent, regionBefore);
      const result: EmbeddedChildMutationResult = {
        family: input.family,
        parentId: input.parentId,
        childId: input.childId,
        parentRevision: await revision(parent.toObject()),
        childRevision: await revision(data),
        data: projectedRecord(data),
        replayed: false,
        ...resultMetadata(data, null),
        deleted: true,
        siblingsVerified: true,
        siblingCount: siblings.size,
      };
      replayCache.set(replay.key, { fingerprint: replay.fingerprint, result });
      return result;
    } catch (error) {
      await restoreMutationState(
        parent,
        input.family,
        collectionBefore,
        completeRegionBefore,
        error,
      );
      throw compensatedFailure(error);
    }
  },
);
