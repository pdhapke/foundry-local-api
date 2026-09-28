import { fileURLToPath } from "node:url";

import type { DurableIdempotencyStore } from "./idempotency-store.js";
import type { EnrollmentStore } from "../bridge/enrollment-store.js";
import { FixtureRegistry } from "./fixture-registry.js";
import { TransactionJournal } from "./transaction-runtime.js";

/** Process-local singleton backed by the module's ignored durable runtime directory. */
export const productionTransactionJournal = new TransactionJournal(
  fileURLToPath(new URL("../../../.runtime/transactions.json", import.meta.url)),
);

export const productionFixtureRegistry = new FixtureRegistry(
  fileURLToPath(new URL("../../../.runtime/fixtures.json", import.meta.url)),
);

export interface FoundationRuntime {
  fixtures: FixtureRegistry;
  idempotency: DurableIdempotencyStore;
  enrollments?: EnrollmentStore;
}
