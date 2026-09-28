import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  ProtocolError,
  type TransactionJournalRecord,
  type TransactionJournalState,
  type TransactionManifest,
} from "@foundry-local-api/shared";

import { computeRevision } from "./revision.js";

/** Durable, payload-redacted transaction state. Before images never leave the Foundry client. */
export class TransactionJournal {
  private readonly records = new Map<string, TransactionJournalRecord>();

  constructor(private readonly path: string | null) {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        TransactionJournalRecord
      >;
      for (const [id, record] of Object.entries(parsed)) this.records.set(id, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  prepare(manifest: TransactionManifest): TransactionJournalRecord {
    const transactionId = manifest.correlationId;
    const inputHash = computeRevision(manifest);
    const existing = this.records.get(transactionId);
    if (existing) {
      if (existing.inputHash !== inputHash) {
        throw new ProtocolError({
          code: "IDEMPOTENCY_CONFLICT",
          message: "The transaction ID is already associated with a different manifest.",
          retryable: false,
          fieldPath: "correlationId",
        });
      }
      return structuredClone(existing);
    }
    const now = new Date().toISOString();
    const record: TransactionJournalRecord = {
      transactionId,
      worldId: manifest.worldId,
      idempotencyKeyHash: computeRevision(manifest.idempotencyKey),
      inputHash,
      state: "pending",
      operationCount: manifest.operations.length,
      operationIds: manifest.operations.map(({ operationId }) => operationId),
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(transactionId, record);
    this.persist();
    return structuredClone(record);
  }

  transition(
    transactionId: string,
    state: TransactionJournalState,
    detail: { committedRevision?: string; errorCode?: TransactionJournalRecord["errorCode"] } = {},
  ): TransactionJournalRecord {
    const current = this.records.get(transactionId);
    if (!current) {
      throw new ProtocolError({
        code: "NOT_FOUND",
        message: "Transaction journal record was not found.",
        retryable: false,
        fieldPath: "transactionId",
      });
    }
    const next: TransactionJournalRecord = {
      ...current,
      state,
      updatedAt: new Date().toISOString(),
      ...(detail.committedRevision ? { committedRevision: detail.committedRevision } : {}),
      ...(detail.errorCode ? { errorCode: detail.errorCode } : {}),
    };
    this.records.set(transactionId, next);
    this.persist();
    return structuredClone(next);
  }

  get(transactionId: string): TransactionJournalRecord {
    const record = this.records.get(transactionId);
    if (!record) {
      throw new ProtocolError({
        code: "NOT_FOUND",
        message: "Transaction journal record was not found.",
        retryable: false,
        fieldPath: "transactionId",
      });
    }
    return structuredClone(record);
  }

  find(transactionId: string): TransactionJournalRecord | undefined {
    const record = this.records.get(transactionId);
    return record ? structuredClone(record) : undefined;
  }

  private persist(): void {
    if (!this.path) return;
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.records), null, 2), "utf8");
    renameSync(temporary, this.path);
  }
}
