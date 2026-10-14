import {
  ProtocolError,
  TRANSACTION_COMMANDS,
  TRANSACTION_DOCUMENT_TYPES,
  isAllowedEmbeddedRelationship,
  orderTransactionOperations,
  type TransactionManifest,
  type TransactionOperation,
  type TransactionOperationResult,
  type TransactionPreflightResult,
  type TransactionRecoveryStep,
  type TransactionRecoveryInput,
  type TransactionRecoveryResult,
  type TransactionResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";
import { validateDocumentSchema } from "./schema-discovery.js";

interface MutableDocument extends FoundryDocument {
  delete(options?: Record<string, unknown>): Promise<FoundryDocument>;
  update(
    changes: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<FoundryDocument>;
  canUserModify?: ((user: unknown, action: "update" | "delete") => boolean) | undefined;
}

interface EmbeddedParent extends MutableDocument {
  getEmbeddedCollection(type: string): Map<string, MutableDocument>;
  createEmbeddedDocuments(
    type: string,
    data: Record<string, unknown>[],
    options?: Record<string, unknown>,
  ): Promise<MutableDocument[]>;
}

interface MutableDocumentClass extends FoundryDocumentClass {
  canUserCreate?: ((user: unknown) => boolean) | undefined;
}

interface PreparedOperation {
  operation: TransactionOperation;
  beforeImage?: Record<string, unknown> | undefined;
  target?: MutableDocument | undefined;
  parent?: EmbeddedParent | undefined;
  normalizedData?: Record<string, unknown> | undefined;
  validationWarnings: Array<{ code: string; path: string; message: string }>;
}

function mergeSource(
  base: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(changes)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      merged[key] &&
      typeof merged[key] === "object" &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = mergeSource(
        merged[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

function validateMutationData(
  operation: TransactionOperation,
  data: Record<string, unknown>,
  mode: "create" | "update",
  beforeImage?: Record<string, unknown>,
): {
  normalized: Record<string, unknown>;
  warnings: Array<{ code: string; path: string; message: string }>;
} {
  const embedded = isEmbeddedOperation(operation);
  const documentType = embedded ? operation.embeddedType : operation.documentType;
  const subtype =
    typeof data["type"] === "string"
      ? data["type"]
      : typeof beforeImage?.["type"] === "string"
        ? beforeImage["type"]
        : undefined;
  const validation = validateDocumentSchema({
    documentType,
    expectedFoundryVersion: game.release.version,
    expectedSystemId: game.system.id,
    expectedSystemVersion: game.system.version,
    ...(embedded ? { parentDocumentType: operation.parentType } : {}),
    ...(subtype ? { subtype } : {}),
    mode,
    data,
  });
  const [candidate] = validation.results;
  if (!candidate?.valid) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "Transaction preflight rejected document data against the active Foundry schema.",
      retryable: false,
      fieldPath: `operations.${operation.operationId}.${mode === "create" ? "data" : "changes"}`,
      details: { errors: candidate?.errors ?? [], warnings: candidate?.warnings ?? [] },
    });
  }
  let completeWarnings: Array<{ code: string; path: string; message: string }> = [];
  if (mode === "update" && beforeImage) {
    const complete = validateDocumentSchema({
      documentType,
      expectedFoundryVersion: game.release.version,
      expectedSystemId: game.system.id,
      expectedSystemVersion: game.system.version,
      ...(embedded ? { parentDocumentType: operation.parentType } : {}),
      ...(subtype ? { subtype } : {}),
      mode: "create",
      data: mergeSource(beforeImage, data),
    }).results[0];
    if (!complete?.valid) {
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: "The complete post-update source fails active Foundry schema validation.",
        retryable: false,
        fieldPath: `operations.${operation.operationId}.changes`,
        details: { errors: complete?.errors ?? [], warnings: complete?.warnings ?? [] },
      });
    }
    completeWarnings = complete.warnings.map(({ code, path, message }) => ({
      code,
      path,
      message,
    }));
  }
  return {
    normalized: candidate.normalized,
    warnings: [
      ...candidate.warnings.map(({ code, path, message }) => ({ code, path, message })),
      ...completeWarnings,
    ],
  };
}

interface AppliedOperation {
  result: TransactionOperationResult;
  recovery: TransactionRecoveryStep;
  compensate: () => Promise<void>;
}

function placeholderResult(
  operation: TransactionOperation,
  id: string,
  validationWarnings: Array<{ code: string; path: string; message: string }>,
): TransactionOperationResult {
  const embedded = isEmbeddedOperation(operation);
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    documentType: embedded ? operation.embeddedType : operation.documentType,
    documentId: id,
    ...(embedded ? { parentType: operation.parentType, parentId: operation.parentId } : {}),
    revision: "pending-compensation",
    validationWarnings,
  };
}

class ApplyAfterMutationError extends Error {
  constructor(readonly applied: AppliedOperation) {
    super("Injected post-write failure before applied-list insertion.");
  }
}

interface PendingRecovery {
  remaining: AppliedOperation[];
  recoveredOperationIds: string[];
}

const pendingRecoveries = new Map<string, PendingRecovery>();

type EmbeddedOperation = Extract<TransactionOperation, { parentType: string }>;

function isEmbeddedOperation(operation: TransactionOperation): operation is EmbeddedOperation {
  return "parentType" in operation;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

/**
 * Foundry rewrites modification bookkeeping whenever a document is restored.
 * Atomic equality therefore covers persistent gameplay/configuration fields,
 * while excluding only those runtime-authored audit timestamps/actors.
 */
export function transactionSemanticSnapshot(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return canonical(value);
  const clone = structuredClone(value as Record<string, unknown>);
  const stats = clone["_stats"];
  if (stats && typeof stats === "object" && !Array.isArray(stats)) {
    const projected = { ...(stats as Record<string, unknown>) };
    delete projected["modifiedTime"];
    delete projected["modifiedBy"];
    delete projected["lastModifiedBy"];
    clone["_stats"] = projected;
  }
  return canonical(clone);
}

export async function transactionRevision(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(transactionSemanticSnapshot(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function collection(type: string): Map<string, MutableDocument> {
  const result = game.collections.get(type) as Map<string, MutableDocument> | undefined;
  if (!result) {
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message: `Document type "${type}" is not available in this world.`,
      retryable: false,
      fieldPath: "operations.documentType",
    });
  }
  return result;
}

function documentClass(type: string): MutableDocumentClass {
  const result = CONFIG[type]?.documentClass as MutableDocumentClass | undefined;
  if (!result) {
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message: `Document type "${type}" cannot be created in this world.`,
      retryable: false,
      fieldPath: "operations.documentType",
    });
  }
  return result;
}

function requireDocument(type: string, id: string): MutableDocument {
  const document = collection(type).get(id);
  if (!document) {
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: `${type} "${id}" was not found.`,
      retryable: false,
      fieldPath: "operations.documentId",
    });
  }
  return document;
}

function requireParent(type: string, id: string): EmbeddedParent {
  const parent = requireDocument(type, id) as EmbeddedParent;
  if (
    typeof parent.getEmbeddedCollection !== "function" ||
    typeof parent.createEmbeddedDocuments !== "function"
  ) {
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message: `${type} does not expose compensable embedded-document operations.`,
      retryable: false,
      fieldPath: "operations.parentType",
    });
  }
  return parent;
}

function requireEmbedded(parent: EmbeddedParent, type: string, id: string): MutableDocument {
  const document = parent.getEmbeddedCollection(type).get(id);
  if (!document) {
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: `${type} "${id}" was not found on ${parent.id}.`,
      retryable: false,
      fieldPath: "operations.embeddedId",
    });
  }
  return document;
}

function assertAllowed(operation: TransactionOperation): void {
  if (
    !(TRANSACTION_DOCUMENT_TYPES as readonly string[]).includes(
      "documentType" in operation ? operation.documentType : operation.parentType,
    )
  ) {
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message: "The requested document type is not in the atomic transaction allowlist.",
      retryable: false,
      fieldPath: "operations.documentType",
    });
  }
  const compensable = isEmbeddedOperation(operation)
    ? operation.parentType === "JournalEntry" && operation.embeddedType === "JournalEntryPage"
    : operation.documentType === "JournalEntry" || operation.documentType === "Item";
  if (!compensable) {
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message:
        "This document operation has Foundry side effects that are not proven compensable in strict-compensation mode.",
      retryable: false,
      fieldPath: "operations.documentType",
      details: { uncompensated: true, operationId: operation.operationId },
    });
  }
  if (
    isEmbeddedOperation(operation) &&
    !isAllowedEmbeddedRelationship(operation.parentType, operation.embeddedType)
  ) {
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message: `${operation.embeddedType} is not an allowed child of ${operation.parentType}.`,
      retryable: false,
      fieldPath: "operations.embeddedType",
    });
  }
  if (
    operation.kind === "document.delete" &&
    (["Folder", "Playlist", "Scene"] as const).includes(
      operation.documentType as "Folder" | "Playlist" | "Scene",
    )
  ) {
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message: `${operation.documentType} deletion has persistent or runtime side effects that cannot be completely compensated and is excluded from strict-compensation mode.`,
      retryable: false,
      fieldPath: "operations.kind",
      details: { uncompensated: true, operationId: operation.operationId },
    });
  }
}

function requireCreateId(operation: TransactionOperation, data: Record<string, unknown>): string {
  const id = data["_id"];
  if (typeof id !== "string" || !/^[A-Za-z0-9]{16}$/.test(id)) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "Atomic creates require a caller-supplied 16-character alphanumeric _id.",
      retryable: false,
      fieldPath: `operations.${operation.operationId}.data._id`,
    });
  }
  return id;
}

function assertPermission(
  target: MutableDocument | EmbeddedParent | MutableDocumentClass,
  action: "create" | "update" | "delete",
): void {
  const allowed =
    action === "create" && "canUserCreate" in target && typeof target.canUserCreate === "function"
      ? target.canUserCreate(game.user)
      : "canUserModify" in target && typeof target.canUserModify === "function"
        ? target.canUserModify(game.user, action === "create" ? "update" : action)
        : false;
  if (!allowed) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: `The executing Foundry user cannot ${action} this transaction target.`,
      retryable: false,
      fieldPath: "operations",
    });
  }
}

function fixtureRunId(data: Record<string, unknown>): string | undefined {
  const flags = data["flags"];
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) return undefined;
  const moduleFlags = (flags as Record<string, unknown>)["foundry-local-api"];
  if (!moduleFlags || typeof moduleFlags !== "object" || Array.isArray(moduleFlags))
    return undefined;
  const value = (moduleFlags as Record<string, unknown>)["testRunId"];
  return typeof value === "string" ? value : undefined;
}

function assertFailureFixture(
  data: Record<string, unknown>,
  testRunId: string,
  fieldPath: string,
): void {
  if (fixtureRunId(data) !== testRunId) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "Failure injection is limited to documents owned by the exact synthetic test run.",
      retryable: false,
      fieldPath,
    });
  }
}

async function assertRevision(expected: string, data: Record<string, unknown>): Promise<void> {
  const actual = await transactionRevision(data);
  if (actual !== expected) {
    throw new ProtocolError({
      code: "STALE_REVISION",
      message: "A transaction target changed after it was read.",
      retryable: true,
      fieldPath: "operations.expectedRevision",
      details: { expected, actual },
    });
  }
}

export async function preflightTransaction(
  manifest: TransactionManifest,
): Promise<PreparedOperation[]> {
  if (manifest.mode !== "atomic") {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "Only atomic transaction mode is supported.",
      retryable: false,
      fieldPath: "mode",
    });
  }
  if (manifest.rollbackPolicy !== "strict") {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "Atomic transactions require the strict rollback policy.",
      retryable: false,
      fieldPath: "rollbackPolicy",
    });
  }
  if (manifest.worldId !== game.world.id) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "The transaction manifest targets a different Foundry world.",
      retryable: false,
      fieldPath: "worldId",
      details: { expected: game.world.id, actual: manifest.worldId },
    });
  }
  if (!game.user.isGM) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "Atomic multi-document transactions require an executing GM client.",
      retryable: false,
      fieldPath: "effectiveUserId",
    });
  }
  if (
    manifest.failureInjection &&
    !/^test-[A-Za-z0-9][A-Za-z0-9._-]+$/.test(manifest.failureInjection.testRunId)
  ) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "Failure injection is limited to namespaced synthetic test runs.",
      retryable: false,
      fieldPath: "failureInjection.testRunId",
    });
  }
  const ordered = orderTransactionOperations(manifest.operations);
  if (
    manifest.failureInjection &&
    !ordered.some(({ operationId }) => operationId === manifest.failureInjection?.afterOperationId)
  ) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "Failure injection references an unknown operation.",
      retryable: false,
      fieldPath: "failureInjection.afterOperationId",
    });
  }
  const targets = new Set<string>();
  const embeddedParents = new Set<string>();
  const prepared: PreparedOperation[] = [];
  for (const operation of ordered) {
    assertAllowed(operation);
    if (operation.kind === "document.create") {
      const cls = documentClass(operation.documentType);
      assertPermission(cls, "create");
      if (manifest.failureInjection) {
        assertFailureFixture(
          operation.data,
          manifest.failureInjection.testRunId,
          "operations.data.flags",
        );
      }
      const createId = requireCreateId(operation, operation.data);
      const key = `${operation.documentType}:${createId}`;
      if (targets.has(key) || collection(operation.documentType).has(createId)) {
        throw duplicateTarget(key);
      }
      targets.add(key);
      const validated = validateMutationData(operation, operation.data, "create");
      prepared.push({
        operation,
        normalizedData: { ...validated.normalized, _id: createId },
        validationWarnings: validated.warnings,
      });
      continue;
    }
    if (operation.kind === "document.update" || operation.kind === "document.delete") {
      const key = `${operation.documentType}:${operation.documentId}`;
      if (targets.has(key)) throw duplicateTarget(key);
      targets.add(key);
      const target = requireDocument(operation.documentType, operation.documentId);
      assertPermission(target, operation.kind === "document.update" ? "update" : "delete");
      const beforeImage = target.toObject();
      if (manifest.failureInjection) {
        assertFailureFixture(
          beforeImage,
          manifest.failureInjection.testRunId,
          "operations.documentId",
        );
      }
      await assertRevision(operation.expectedRevision, beforeImage);
      const validated =
        operation.kind === "document.update"
          ? validateMutationData(operation, operation.changes, "update", beforeImage)
          : undefined;
      prepared.push({
        operation,
        target,
        beforeImage,
        ...(validated ? { normalizedData: validated.normalized } : {}),
        validationWarnings: validated?.warnings ?? [],
      });
      continue;
    }
    const parent = requireParent(operation.parentType, operation.parentId);
    assertPermission(parent, "update");
    const parentKey = `${operation.parentType}:${operation.parentId}`;
    if (embeddedParents.has(parentKey)) throw duplicateTarget(parentKey);
    embeddedParents.add(parentKey);
    await assertRevision(operation.expectedParentRevision, parent.toObject());
    if (manifest.failureInjection) {
      assertFailureFixture(
        parent.toObject(),
        manifest.failureInjection.testRunId,
        "operations.parentId",
      );
    }
    if (operation.kind === "embedded.create") {
      if (manifest.failureInjection) {
        assertFailureFixture(
          operation.data,
          manifest.failureInjection.testRunId,
          "operations.data.flags",
        );
      }
      const createId = requireCreateId(operation, operation.data);
      const key = `${parentKey}:${operation.embeddedType}:${createId}`;
      if (targets.has(key) || parent.getEmbeddedCollection(operation.embeddedType).has(createId)) {
        throw duplicateTarget(key);
      }
      targets.add(key);
      const validated = validateMutationData(operation, operation.data, "create");
      prepared.push({
        operation,
        parent,
        normalizedData: { ...validated.normalized, _id: createId },
        validationWarnings: validated.warnings,
      });
      continue;
    }
    const key = `${operation.parentType}:${operation.parentId}:${operation.embeddedType}:${operation.embeddedId}`;
    if (targets.has(key)) throw duplicateTarget(key);
    targets.add(key);
    const target = requireEmbedded(parent, operation.embeddedType, operation.embeddedId);
    assertPermission(target, operation.kind === "embedded.update" ? "update" : "delete");
    const beforeImage = target.toObject();
    if (manifest.failureInjection) {
      assertFailureFixture(
        beforeImage,
        manifest.failureInjection.testRunId,
        "operations.embeddedId",
      );
    }
    await assertRevision(operation.expectedRevision, beforeImage);
    const validated =
      operation.kind === "embedded.update"
        ? validateMutationData(operation, operation.changes, "update", beforeImage)
        : undefined;
    prepared.push({
      operation,
      parent,
      target,
      beforeImage,
      ...(validated ? { normalizedData: validated.normalized } : {}),
      validationWarnings: validated?.warnings ?? [],
    });
  }
  return prepared;
}

export async function preflightTransactionResult(
  manifest: TransactionManifest,
): Promise<TransactionPreflightResult> {
  const prepared = await preflightTransaction(manifest);
  return {
    transactionId: manifest.correlationId,
    correlationId: manifest.correlationId,
    atomic: false,
    transactionSemantics: "strict-verified-compensation",
    limitations: [
      "Foundry does not expose database-isolated multi-document transactions.",
      "Browser crashes can interrupt compensation and already-observed hook side effects cannot be undone.",
    ],
    valid: true,
    executionOrder: prepared.map(({ operation }) => operation.operationId),
    checkedRevisions: await Promise.all(
      prepared
        .filter(({ beforeImage }) => beforeImage !== undefined)
        .map(async ({ operation, beforeImage }) => ({
          operationId: operation.operationId,
          revision: await transactionRevision(beforeImage),
        })),
    ),
    validationWarnings: prepared
      .filter(({ validationWarnings }) => validationWarnings.length > 0)
      .map(({ operation, validationWarnings }) => ({
        operationId: operation.operationId,
        warnings: validationWarnings,
      })),
  };
}

function duplicateTarget(key: string): ProtocolError {
  return new ProtocolError({
    code: "INVALID_PAYLOAD",
    message: `Strict-compensation manifests may mutate target "${key}" only once.`,
    retryable: false,
    fieldPath: "operations",
  });
}

async function assertCommitCas(prepared: PreparedOperation): Promise<void> {
  const { operation } = prepared;
  if (isEmbeddedOperation(operation)) {
    await assertRevision(operation.expectedParentRevision, prepared.parent!.toObject());
  }
  if (operation.kind === "document.create") {
    if (collection(operation.documentType).has(String(prepared.normalizedData!["_id"]))) {
      throw new ProtocolError({
        code: "STALE_REVISION",
        message: "The create ID became occupied after preflight.",
        retryable: true,
        fieldPath: "operations.data._id",
      });
    }
  } else if (operation.kind === "embedded.create") {
    if (
      prepared
        .parent!.getEmbeddedCollection(operation.embeddedType)
        .has(String(prepared.normalizedData!["_id"]))
    ) {
      throw new ProtocolError({
        code: "STALE_REVISION",
        message: "The embedded create ID became occupied after preflight.",
        retryable: true,
        fieldPath: "operations.data._id",
      });
    }
  } else {
    await assertRevision(operation.expectedRevision, prepared.target!.toObject());
  }
}

function maybeInjectPostWrite(
  applied: AppliedOperation,
  manifest: TransactionManifest,
): AppliedOperation {
  if (
    manifest.failureInjection?.afterOperationId === applied.result.operationId &&
    manifest.failureInjection.point === "postWriteBeforeRecord"
  ) {
    throw new ApplyAfterMutationError(applied);
  }
  return applied;
}

async function compensateCurrentAndRethrow(
  applied: AppliedOperation,
  cause: unknown,
): Promise<never> {
  try {
    await applied.compensate();
  } catch {
    throw new ApplyAfterMutationError(applied);
  }
  throw cause;
}

/** Provenance is produced by the validated bridge executor, never copied from document data.
 * This is an event echo marker, not an authorization grant. Every compensation keeps correlation.
 */
export function transactionMutationOptions(manifest: TransactionManifest, phase: "apply" | "compensate"): Record<string, unknown> {
  return { correlationId: manifest.correlationId, foundryLocalApiOrigin: { source: "foundry-local-api.transaction", phase, correlationId: manifest.correlationId } };
}

async function apply(
  prepared: PreparedOperation,
  manifest: TransactionManifest,
): Promise<AppliedOperation> {
  const { operation } = prepared;
  await assertCommitCas(prepared);
  if (operation.kind === "document.create") {
    let created: MutableDocument | undefined;
    try {
      created = (await documentClass(operation.documentType).create(prepared.normalizedData!, {
        keepId: true,
        ...transactionMutationOptions(manifest, "apply"),
      })) as MutableDocument | undefined;
    } catch (cause) {
      const escaped = collection(operation.documentType).get(
        String(prepared.normalizedData!["_id"]),
      );
      if (escaped) {
        const escapedApplied: AppliedOperation = {
          result: placeholderResult(operation, escaped.id, prepared.validationWarnings),
          recovery: recovery(operation, escaped.id, "delete-created"),
          compensate: async () => {
            await escaped.delete(transactionMutationOptions(manifest, "compensate"));
            if (collection(operation.documentType).has(escaped.id))
              throw new Error("Created document survived compensation.");
          },
        };
        return compensateCurrentAndRethrow(escapedApplied, cause);
      }
      throw cause;
    }
    if (!created) throw new Error(`Failed to create ${operation.documentType}.`);
    const planned: AppliedOperation = {
      result: placeholderResult(operation, created.id, prepared.validationWarnings),
      recovery: recovery(operation, created.id, "delete-created"),
      compensate: async () => {
        await created.delete(transactionMutationOptions(manifest, "compensate"));
        if (collection(operation.documentType).has(created.id)) {
          throw new Error(`Created ${operation.documentType} ${created.id} survived compensation.`);
        }
      },
    };
    try {
      const completed: AppliedOperation = {
        result: await result(
          operation,
          created.id,
          created.toObject(),
          prepared.validationWarnings,
        ),
        recovery: planned.recovery,
        compensate: planned.compensate,
      };
      return maybeInjectPostWrite(completed, manifest);
    } catch (cause) {
      if (cause instanceof ApplyAfterMutationError) throw cause;
      return compensateCurrentAndRethrow(planned, cause);
    }
  }
  if (operation.kind === "document.update") {
    const target = prepared.target!;
    const planned = await restoreApplied(
      operation,
      target,
      prepared.beforeImage!,
      prepared.validationWarnings,
      manifest,
    );
    try {
      await target.update(prepared.normalizedData!, transactionMutationOptions(manifest, "apply"));
    } catch (cause) {
      return compensateCurrentAndRethrow(planned, cause);
    }
    try {
      return maybeInjectPostWrite(
        await restoreApplied(operation, target, prepared.beforeImage!, prepared.validationWarnings, manifest),
        manifest,
      );
    } catch (cause) {
      if (cause instanceof ApplyAfterMutationError) throw cause;
      return compensateCurrentAndRethrow(planned, cause);
    }
  }
  if (operation.kind === "document.delete") {
    const target = prepared.target!;
    const beforeImage = prepared.beforeImage!;
    const planned: AppliedOperation = {
      result: await result(
        operation,
        operation.documentId,
        beforeImage,
        prepared.validationWarnings,
      ),
      recovery: recovery(operation, operation.documentId, "recreate-deleted"),
      compensate: async () => {
        const restored = await documentClass(operation.documentType).create(beforeImage, {
          keepId: true,
          ...transactionMutationOptions(manifest, "compensate"),
        });
        if (
          !restored ||
          (await transactionRevision(restored.toObject())) !==
            (await transactionRevision(beforeImage))
        ) {
          throw new Error(
            `Exact recreation failed for ${operation.documentType} ${operation.documentId}.`,
          );
        }
      },
    };
    try {
      await target.delete(transactionMutationOptions(manifest, "apply"));
    } catch (cause) {
      if (!collection(operation.documentType).has(operation.documentId)) {
        return compensateCurrentAndRethrow(planned, cause);
      }
      throw cause;
    }
    return maybeInjectPostWrite(
      {
        ...planned,
      },
      manifest,
    );
  }
  const parent = prepared.parent!;
  if (operation.kind === "embedded.create") {
    let created: MutableDocument | undefined;
    try {
      [created] = await parent.createEmbeddedDocuments(
        operation.embeddedType,
        [prepared.normalizedData!],
        { keepId: true, ...transactionMutationOptions(manifest, "apply") },
      );
    } catch (cause) {
      const escaped = parent
        .getEmbeddedCollection(operation.embeddedType)
        .get(String(prepared.normalizedData!["_id"]));
      if (escaped) {
        const escapedApplied: AppliedOperation = {
          result: placeholderResult(operation, escaped.id, prepared.validationWarnings),
          recovery: recovery(operation, escaped.id, "delete-created"),
          compensate: async () => {
            await escaped.delete(transactionMutationOptions(manifest, "compensate"));
            if (parent.getEmbeddedCollection(operation.embeddedType).has(escaped.id))
              throw new Error("Created embedded document survived compensation.");
          },
        };
        return compensateCurrentAndRethrow(escapedApplied, cause);
      }
      throw cause;
    }
    if (!created) throw new Error(`Failed to create ${operation.embeddedType}.`);
    const planned: AppliedOperation = {
      result: placeholderResult(operation, created.id, prepared.validationWarnings),
      recovery: recovery(operation, created.id, "delete-created"),
      compensate: async () => {
        await created.delete(transactionMutationOptions(manifest, "compensate"));
        if (parent.getEmbeddedCollection(operation.embeddedType).has(created.id)) {
          throw new Error(`Created ${operation.embeddedType} ${created.id} survived compensation.`);
        }
      },
    };
    try {
      const completed: AppliedOperation = {
        result: await result(
          operation,
          created.id,
          created.toObject(),
          prepared.validationWarnings,
        ),
        recovery: planned.recovery,
        compensate: planned.compensate,
      };
      return maybeInjectPostWrite(completed, manifest);
    } catch (cause) {
      if (cause instanceof ApplyAfterMutationError) throw cause;
      return compensateCurrentAndRethrow(planned, cause);
    }
  }
  if (operation.kind === "embedded.update") {
    const target = prepared.target!;
    const planned = await restoreApplied(
      operation,
      target,
      prepared.beforeImage!,
      prepared.validationWarnings,
      manifest,
    );
    try {
      await target.update(prepared.normalizedData!, transactionMutationOptions(manifest, "apply"));
    } catch (cause) {
      return compensateCurrentAndRethrow(planned, cause);
    }
    try {
      return maybeInjectPostWrite(
        await restoreApplied(operation, target, prepared.beforeImage!, prepared.validationWarnings, manifest),
        manifest,
      );
    } catch (cause) {
      if (cause instanceof ApplyAfterMutationError) throw cause;
      return compensateCurrentAndRethrow(planned, cause);
    }
  }
  const target = prepared.target!;
  const beforeImage = prepared.beforeImage!;
  const planned: AppliedOperation = {
    result: await result(operation, operation.embeddedId, beforeImage, prepared.validationWarnings),
    recovery: recovery(operation, operation.embeddedId, "recreate-deleted"),
    compensate: async () => {
      const [restored] = await parent.createEmbeddedDocuments(
        operation.embeddedType,
        [beforeImage],
        { keepId: true, ...transactionMutationOptions(manifest, "compensate") },
      );
      if (
        !restored ||
        (await transactionRevision(restored.toObject())) !==
          (await transactionRevision(beforeImage))
      ) {
        throw new Error(
          `Exact recreation failed for ${operation.embeddedType} ${operation.embeddedId}.`,
        );
      }
    },
  };
  try {
    await target.delete(transactionMutationOptions(manifest, "apply"));
  } catch (cause) {
    if (!parent.getEmbeddedCollection(operation.embeddedType).has(operation.embeddedId)) {
      return compensateCurrentAndRethrow(planned, cause);
    }
    throw cause;
  }
  return maybeInjectPostWrite(planned, manifest);
}

async function restoreApplied(
  operation: TransactionOperation,
  target: MutableDocument,
  beforeImage: Record<string, unknown>,
  validationWarnings: Array<{ code: string; path: string; message: string }>,
  manifest: TransactionManifest,
): Promise<AppliedOperation> {
  const data = target.toObject();
  if (!("documentId" in operation) && !("embeddedId" in operation)) {
    throw new Error(`Cannot restore a create operation (${operation.operationId}).`);
  }
  const id = "documentId" in operation ? operation.documentId : operation.embeddedId;
  return {
    result: await result(operation, id, data, validationWarnings),
    recovery: recovery(operation, id, "restore-before-image"),
    compensate: async () => {
      await target.update(beforeImage, { diff: false, recursive: false, ...transactionMutationOptions(manifest, "compensate") });
      if (
        (await transactionRevision(target.toObject())) !== (await transactionRevision(beforeImage))
      ) {
        throw new Error(`Exact before-image restoration failed for ${id}.`);
      }
    },
  };
}

function recovery(
  operation: TransactionOperation,
  id: string,
  action: TransactionRecoveryStep["action"],
): TransactionRecoveryStep {
  const embedded = isEmbeddedOperation(operation);
  return {
    operationId: operation.operationId,
    action,
    documentType: embedded ? operation.embeddedType : operation.documentType,
    documentId: id,
    ...(embedded ? { parentType: operation.parentType, parentId: operation.parentId } : {}),
  };
}

async function result(
  operation: TransactionOperation,
  id: string,
  data: Record<string, unknown>,
  validationWarnings: Array<{ code: string; path: string; message: string }>,
): Promise<TransactionOperationResult> {
  const embedded = isEmbeddedOperation(operation);
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    documentType: embedded ? operation.embeddedType : operation.documentType,
    documentId: id,
    ...(embedded ? { parentType: operation.parentType, parentId: operation.parentId } : {}),
    revision: await transactionRevision(data),
    validationWarnings,
  };
}

export async function executeAtomicTransaction(
  manifest: TransactionManifest,
): Promise<TransactionResult> {
  const prepared = await preflightTransaction(manifest);
  const applied: AppliedOperation[] = [];
  let failedOperationId = prepared[0]?.operation.operationId ?? "preflight";
  try {
    for (const entry of prepared) {
      failedOperationId = entry.operation.operationId;
      try {
        applied.push(await apply(entry, manifest));
      } catch (error) {
        if (error instanceof ApplyAfterMutationError) applied.push(error.applied);
        throw error;
      }
      if (
        manifest.failureInjection?.afterOperationId === entry.operation.operationId &&
        manifest.failureInjection.point !== "postWriteBeforeRecord"
      ) {
        throw new Error(`Injected failure after ${entry.operation.operationId}.`);
      }
    }
    const operationResults = applied.map(({ result: operationResult }) => operationResult);
    return {
      transactionId: manifest.correlationId,
      correlationId: manifest.correlationId,
      idempotencyKey: manifest.idempotencyKey,
      committed: true,
      atomic: false,
      transactionSemantics: "strict-verified-compensation",
      limitations: [
        "Foundry does not expose database-isolated multi-document transactions.",
        "Browser crashes can interrupt compensation and already-observed hook side effects cannot be undone.",
      ],
      replayed: false,
      executionOrder: prepared.map(({ operation }) => operation.operationId),
      operations: operationResults,
      committedRevision: await transactionRevision(operationResults),
    };
  } catch (cause) {
    const rolledBackOperationIds: string[] = [];
    const recoveryManifest: TransactionRecoveryStep[] = [];
    for (const entry of [...applied].reverse()) {
      try {
        await entry.compensate();
        rolledBackOperationIds.push(entry.result.operationId);
      } catch {
        recoveryManifest.push(entry.recovery);
      }
    }
    if (recoveryManifest.length > 0) {
      pendingRecoveries.set(manifest.correlationId, {
        remaining: applied.filter((entry) =>
          recoveryManifest.some(({ operationId }) => operationId === entry.result.operationId),
        ),
        recoveredOperationIds: [],
      });
      throw new ProtocolError({
        code: "ROLLBACK_FAILED",
        message:
          "Verified compensation could not restore every before image; manual recovery is required.",
        retryable: false,
        correlationId: manifest.correlationId,
        details: { failedOperationId, rolledBackOperationIds, recoveryManifest },
      });
    }
    throw new ProtocolError({
      code: cause instanceof ProtocolError ? cause.code : "HANDLER_ERROR",
      message: `Transaction failed at "${failedOperationId}" and all applied operations were rolled back.`,
      retryable: cause instanceof ProtocolError ? cause.retryable : false,
      correlationId: manifest.correlationId,
      details: { failedOperationId, rolledBackOperationIds, persistentPartialSuccess: false },
    });
  }
}

export async function recoverAtomicTransaction(
  input: TransactionRecoveryInput,
): Promise<TransactionRecoveryResult> {
  if (input.worldId !== game.world.id) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "Recovery targets a different Foundry world.",
      retryable: false,
      fieldPath: "worldId",
    });
  }
  if (!game.user.isGM) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "Transaction recovery requires an executing GM client.",
      retryable: false,
    });
  }
  const pending = pendingRecoveries.get(input.transactionId);
  if (!pending) {
    throw new ProtocolError({
      code: "NOT_FOUND",
      message:
        "No in-memory recovery plan exists for this transaction; the executing browser may have restarted.",
      retryable: false,
      fieldPath: "transactionId",
    });
  }
  while (pending.remaining.length > 0) {
    const entry = pending.remaining.at(-1)!;
    try {
      await entry.compensate();
      pending.recoveredOperationIds.push(entry.result.operationId);
      pending.remaining.pop();
      pendingRecoveries.set(input.transactionId, pending);
    } catch {
      throw new ProtocolError({
        code: "ROLLBACK_FAILED",
        message: "Recovery remains incomplete.",
        retryable: false,
        correlationId: input.transactionId,
        details: {
          recoveredOperationIds: pending.recoveredOperationIds,
          recoveryManifest: pending.remaining.map(({ recovery }) => recovery),
        },
      });
    }
  }
  pendingRecoveries.delete(input.transactionId);
  return {
    transactionId: input.transactionId,
    rolledBack: true,
    recoveredOperationIds: pending.recoveredOperationIds,
  };
}

registerCommand(TRANSACTION_COMMANDS.EXECUTE, executeAtomicTransaction);
registerCommand(TRANSACTION_COMMANDS.PREFLIGHT, preflightTransactionResult);
registerCommand(TRANSACTION_COMMANDS.RECOVER, recoverAtomicTransaction);
