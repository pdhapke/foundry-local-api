import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ProtocolError, assertIdempotencyKey } from "@foundry-local-api/shared";

import { computeRevision } from "./revision.js";

interface PendingEntry {
  state: "pending";
  inputHash: string;
  startedAt: string;
}

interface CommittedEntry {
  state: "committed";
  inputHash: string;
  result: unknown;
  committedAt: string;
}

type StoredEntry = PendingEntry | CommittedEntry;

export interface IdempotentResult<T> {
  result: T;
  replayed: boolean;
}

interface InFlightEntry {
  inputHash: string;
  promise: Promise<IdempotentResult<unknown>>;
}

export class DurableIdempotencyStore {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        StoredEntry | Omit<CommittedEntry, "state">
      >;
      for (const [key, entry] of Object.entries(parsed)) {
        this.entries.set(key, "state" in entry ? entry : { ...entry, state: "committed" });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async execute<T>(
    key: string,
    input: unknown,
    operation: () => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    assertIdempotencyKey(key);
    const inputHash = computeRevision(input);
    const inFlight = this.inFlight.get(key);
    if (inFlight) {
      if (inFlight.inputHash !== inputHash) {
        throw new ProtocolError({
          code: "IDEMPOTENCY_CONFLICT",
          message: "The idempotency key is already executing with different input.",
          retryable: false,
          fieldPath: "idempotencyKey",
        });
      }
      return inFlight.promise as Promise<IdempotentResult<T>>;
    }
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.inputHash !== inputHash) {
        throw new ProtocolError({
          code: "IDEMPOTENCY_CONFLICT",
          message: "The idempotency key was already committed with different input.",
          retryable: false,
          fieldPath: "idempotencyKey",
        });
      }
      if (existing.state === "pending") {
        throw new ProtocolError({
          code: "INCOMPLETE_RESULT",
          message:
            "A prior attempt with this idempotency key did not record a committed result; reconcile its transaction before retrying.",
          retryable: false,
          fieldPath: "idempotencyKey",
          details: { state: "pending", startedAt: existing.startedAt },
        });
      }
      return { result: existing.result as T, replayed: true };
    }
    this.entries.set(key, { state: "pending", inputHash, startedAt: new Date().toISOString() });
    this.persist();
    const promise = operation()
      .then((result) => {
        this.entries.set(key, {
          state: "committed",
          inputHash,
          result,
          committedAt: new Date().toISOString(),
        });
        this.persist();
        return { result, replayed: false };
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, {
      inputHash,
      promise: promise as Promise<IdempotentResult<unknown>>,
    });
    return promise;
  }

  /** Clears only a matching pending marker after the caller has verified complete rollback. */
  resolvePendingAsRolledBack(key: string, input: unknown): void {
    assertIdempotencyKey(key);
    const existing = this.entries.get(key);
    if (!existing) return;
    const inputHash = computeRevision(input);
    if (existing.inputHash !== inputHash) {
      throw new ProtocolError({
        code: "IDEMPOTENCY_CONFLICT",
        message: "The pending idempotency key belongs to different input.",
        retryable: false,
        fieldPath: "idempotencyKey",
      });
    }
    if (existing.state === "committed") {
      throw new ProtocolError({
        code: "IDEMPOTENCY_CONFLICT",
        message: "A committed idempotency result cannot be cleared as rolled back.",
        retryable: false,
        fieldPath: "idempotencyKey",
      });
    }
    this.entries.delete(key);
    this.persist();
  }

  private persist(): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.entries), null, 2), "utf8");
    renameSync(temporary, this.path);
  }
}
