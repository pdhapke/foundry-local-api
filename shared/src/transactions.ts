import { ProtocolError, type ProtocolErrorCode } from "./foundations.js";

export const TRANSACTION_COMMANDS = {
  PREFLIGHT: "transactionPreflight",
  EXECUTE: "transactionExecute",
  RECOVER: "transactionRecover",
} as const;

export const TRANSACTION_DOCUMENT_TYPES = [
  "Actor",
  "Cards",
  "Folder",
  "Item",
  "JournalEntry",
  "Macro",
  "Playlist",
  "RollTable",
  "Scene",
] as const;

export type TransactionDocumentType = (typeof TRANSACTION_DOCUMENT_TYPES)[number];

export const TRANSACTION_EMBEDDED_RELATIONSHIPS = {
  Actor: ["ActiveEffect", "Item"],
  Cards: ["Card"],
  Item: ["ActiveEffect"],
  JournalEntry: ["JournalEntryPage"],
  Playlist: ["PlaylistSound"],
  RollTable: ["TableResult"],
  Scene: [
    "AmbientLight",
    "AmbientSound",
    "Drawing",
    "MeasuredTemplate",
    "Note",
    "Region",
    "Tile",
    "Token",
    "Wall",
  ],
} as const;

export type TransactionOperationKind =
  | "document.create"
  | "document.update"
  | "document.delete"
  | "embedded.create"
  | "embedded.update"
  | "embedded.delete";

interface TransactionOperationBase {
  operationId: string;
  kind: TransactionOperationKind;
  dependsOn?: string[] | undefined;
}

export interface TransactionDocumentCreateOperation extends TransactionOperationBase {
  kind: "document.create";
  documentType: TransactionDocumentType;
  data: Record<string, unknown>;
}

export interface TransactionDocumentUpdateOperation extends TransactionOperationBase {
  kind: "document.update";
  documentType: TransactionDocumentType;
  documentId: string;
  expectedRevision: string;
  changes: Record<string, unknown>;
}

export interface TransactionDocumentDeleteOperation extends TransactionOperationBase {
  kind: "document.delete";
  documentType: TransactionDocumentType;
  documentId: string;
  expectedRevision: string;
}

interface TransactionEmbeddedBase extends TransactionOperationBase {
  parentType: TransactionDocumentType;
  parentId: string;
  embeddedType: string;
  expectedParentRevision: string;
}

export interface TransactionEmbeddedCreateOperation extends TransactionEmbeddedBase {
  kind: "embedded.create";
  data: Record<string, unknown>;
}

export interface TransactionEmbeddedUpdateOperation extends TransactionEmbeddedBase {
  kind: "embedded.update";
  embeddedId: string;
  expectedRevision: string;
  changes: Record<string, unknown>;
}

export interface TransactionEmbeddedDeleteOperation extends TransactionEmbeddedBase {
  kind: "embedded.delete";
  embeddedId: string;
  expectedRevision: string;
}

export type TransactionOperation =
  | TransactionDocumentCreateOperation
  | TransactionDocumentUpdateOperation
  | TransactionDocumentDeleteOperation
  | TransactionEmbeddedCreateOperation
  | TransactionEmbeddedUpdateOperation
  | TransactionEmbeddedDeleteOperation;

export interface TransactionFailureInjection {
  /** Only accepted for a namespaced synthetic test run. */
  testRunId: string;
  afterOperationId: string;
  point?: "afterOperation" | "postWriteBeforeRecord" | undefined;
}

export interface TransactionManifest {
  mode: "atomic";
  rollbackPolicy: "strict";
  worldId: string;
  correlationId: string;
  idempotencyKey: string;
  operations: TransactionOperation[];
  failureInjection?: TransactionFailureInjection | undefined;
}

export interface TransactionOperationResult {
  operationId: string;
  kind: TransactionOperationKind;
  documentType: string;
  documentId: string;
  parentType?: string | undefined;
  parentId?: string | undefined;
  revision: string;
  validationWarnings: Array<{ code: string; path: string; message: string }>;
}

export interface TransactionRecoveryStep {
  operationId: string;
  action: "delete-created" | "restore-before-image" | "recreate-deleted";
  documentType: string;
  documentId: string;
  parentType?: string | undefined;
  parentId?: string | undefined;
}

export interface TransactionResult {
  transactionId: string;
  correlationId: string;
  idempotencyKey: string;
  committed: true;
  atomic: true;
  replayed: boolean;
  executionOrder: string[];
  operations: TransactionOperationResult[];
  committedRevision: string;
}

export interface TransactionExecutionResult extends TransactionResult {
  executionContext: {
    clientId: string;
    userId: string;
    foundryVersion: string;
    systemId: string;
    systemVersion: string;
    moduleVersion: string;
  };
}

export interface TransactionPreflightResult {
  transactionId: string;
  correlationId: string;
  atomic: true;
  valid: true;
  executionOrder: string[];
  checkedRevisions: Array<{ operationId: string; revision: string }>;
  validationWarnings: Array<{
    operationId: string;
    warnings: Array<{ code: string; path: string; message: string }>;
  }>;
}

export interface TransactionRecoveryInput {
  transactionId: string;
  worldId: string;
}

export interface TransactionRecoveryResult {
  transactionId: string;
  rolledBack: true;
  recoveredOperationIds: string[];
}

export type TransactionJournalState = "pending" | "committed" | "rolledBack" | "recoveryRequired";

export interface TransactionJournalRecord {
  transactionId: string;
  worldId: string;
  idempotencyKeyHash: string;
  inputHash: string;
  state: TransactionJournalState;
  operationCount: number;
  operationIds: string[];
  createdAt: string;
  updatedAt: string;
  committedRevision?: string | undefined;
  errorCode?: ProtocolErrorCode | undefined;
}

export interface TransactionFailureDetails {
  failedOperationId: string;
  rolledBackOperationIds: string[];
  persistentPartialSuccess: false;
  recoveryManifest?: TransactionRecoveryStep[] | undefined;
}

export interface TransactionErrorShape {
  code: ProtocolErrorCode;
  message: string;
  retryable: boolean;
  correlationId: string;
  details?: TransactionFailureDetails | Record<string, unknown> | undefined;
}

export function isAllowedEmbeddedRelationship(parentType: string, embeddedType: string): boolean {
  const allowed = TRANSACTION_EMBEDDED_RELATIONSHIPS[
    parentType as keyof typeof TRANSACTION_EMBEDDED_RELATIONSHIPS
  ] as readonly string[] | undefined;
  return allowed?.includes(embeddedType) ?? false;
}

/** Stable topological order; input order is retained between otherwise-independent operations. */
export function orderTransactionOperations(
  operations: TransactionOperation[],
): TransactionOperation[] {
  if (operations.length === 0) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "An atomic transaction requires at least one operation.",
      retryable: false,
      fieldPath: "operations",
    });
  }
  const byId = new Map<string, TransactionOperation>();
  for (const [index, operation] of operations.entries()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(operation.operationId)) {
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: "Operation IDs must be 1-64 portable characters.",
        retryable: false,
        fieldPath: `operations.${index}.operationId`,
      });
    }
    if (byId.has(operation.operationId)) {
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: `Duplicate operation ID "${operation.operationId}".`,
        retryable: false,
        fieldPath: `operations.${index}.operationId`,
      });
    }
    byId.set(operation.operationId, operation);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: TransactionOperation[] = [];
  const visit = (operation: TransactionOperation): void => {
    if (visited.has(operation.operationId)) return;
    if (visiting.has(operation.operationId)) {
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: "Transaction dependencies contain a cycle.",
        retryable: false,
        fieldPath: "operations.dependsOn",
      });
    }
    visiting.add(operation.operationId);
    for (const dependencyId of operation.dependsOn ?? []) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        throw new ProtocolError({
          code: "INVALID_PAYLOAD",
          message: `Unknown dependency "${dependencyId}".`,
          retryable: false,
          fieldPath: `operations.${operation.operationId}.dependsOn`,
        });
      }
      visit(dependency);
    }
    visiting.delete(operation.operationId);
    visited.add(operation.operationId);
    ordered.push(operation);
  };
  for (const operation of operations) visit(operation);
  return ordered;
}
