import { z } from "zod";

import {
  ProtocolError,
  TRANSACTION_COMMANDS,
  type TransactionManifest,
  type TransactionExecutionResult,
  type TransactionPreflightResult,
  type TransactionRecoveryInput,
  type TransactionRecoveryResult,
  type TransactionResult,
} from "@foundry-local-api/shared";

import { FoundryBridgeError } from "../bridge/errors.js";
import { computeRevision } from "../foundations/revision.js";
import { TransactionJournal } from "../foundations/transaction-runtime.js";
import type { AnyEndpointDescriptor } from "./types.js";

const portableId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const revision = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
const data = z.record(z.string(), z.unknown());
const createData = data.refine(
  (value) => typeof value["_id"] === "string" && /^[A-Za-z0-9]{16}$/.test(value["_id"]),
  { message: "Atomic creates require a caller-supplied 16-character alphanumeric _id." },
);
// Strict atomic mode is intentionally narrower than the bridge's general CRUD catalog.
const documentType = z.enum(["JournalEntry", "Item"]);
const base = z.object({
  operationId: portableId,
  dependsOn: z.array(portableId).max(100).optional(),
});
const operation = z.discriminatedUnion("kind", [
  base.extend({ kind: z.literal("document.create"), documentType, data: createData }),
  base.extend({
    kind: z.literal("document.update"),
    documentType,
    documentId: z.string().min(1).max(128),
    expectedRevision: revision,
    changes: data,
  }),
  base.extend({
    kind: z.literal("document.delete"),
    documentType,
    documentId: z.string().min(1).max(128),
    expectedRevision: revision,
  }),
  base.extend({
    kind: z.literal("embedded.create"),
    parentType: z.literal("JournalEntry"),
    parentId: z.string().min(1).max(128),
    embeddedType: z.literal("JournalEntryPage"),
    expectedParentRevision: revision,
    data: createData,
  }),
  base.extend({
    kind: z.literal("embedded.update"),
    parentType: z.literal("JournalEntry"),
    parentId: z.string().min(1).max(128),
    embeddedType: z.literal("JournalEntryPage"),
    embeddedId: z.string().min(1).max(128),
    expectedParentRevision: revision,
    expectedRevision: revision,
    changes: data,
  }),
  base.extend({
    kind: z.literal("embedded.delete"),
    parentType: z.literal("JournalEntry"),
    parentId: z.string().min(1).max(128),
    embeddedType: z.literal("JournalEntryPage"),
    embeddedId: z.string().min(1).max(128),
    expectedParentRevision: revision,
    expectedRevision: revision,
  }),
]);

export const transactionManifestSchema = z.object({
  mode: z.literal("atomic"),
  rollbackPolicy: z.literal("strict"),
  worldId: z.string().min(1).max(128),
  correlationId: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  operations: z.array(operation).min(1).max(100),
  failureInjection: z
    .object({
      testRunId: z
        .string()
        .min(6)
        .max(84)
        .regex(/^test-[A-Za-z0-9][A-Za-z0-9._-]+$/),
      afterOperationId: portableId,
      point: z.enum(["afterOperation", "postWriteBeforeRecord"]).optional(),
    })
    .optional(),
});

const transactionIdSchema = z.object({ transactionId: portableId });
const recoverySchema = transactionIdSchema.extend({ worldId: z.string().min(1).max(128) });

export function createTransactionEndpointDescriptors(
  journal: TransactionJournal,
): AnyEndpointDescriptor[] {
  return [
    {
      name: "foundry_preflight_transaction",
      description:
        "Prevalidates an allowlisted strict-compensation manifest, dependency order, permissions, and expected revisions without mutating Foundry. This proves compensability, not database isolation. File uploads and file lifecycle operations are outside manifest scope.",
      method: "post",
      path: "/transactions/preflight",
      inputSchema: transactionManifestSchema,
      handler: (manifest: TransactionManifest, { foundryClient }) =>
        foundryClient.call<TransactionManifest, TransactionPreflightResult>(
          TRANSACTION_COMMANDS.PREFLIGHT,
          manifest,
        ),
      annotations: { readOnlyHint: true },
    },
    {
      name: "foundry_execute_transaction",
      description:
        "Executes a narrowly allowlisted, revision-checked document manifest with strict verified compensation. It restores exact persistent document sources after ordinary failures, but does not claim database isolation: a Foundry browser crash can require manual recovery and already-observed hook side effects cannot be undone. Stable idempotency keys prevent duplicate redispatch. File operations are excluded.",
      method: "post",
      path: "/transactions",
      inputSchema: transactionManifestSchema,
      handler: async (manifest: TransactionManifest, { foundryClient, foundations }) => {
        if (!foundations) throw new Error("Track 0 foundation runtime is not configured.");
        const prior = journal.find(manifest.correlationId);
        if (prior && (prior.state === "pending" || prior.state === "recoveryRequired")) {
          throw new FoundryBridgeError(
            "INCOMPLETE_RESULT",
            `Transaction ${manifest.correlationId} is ${prior.state}; inspect status and recover instead of redispatching.`,
            { retryable: false, correlationId: manifest.correlationId },
          );
        }
        try {
          journal.prepare(manifest);
          if (prior?.state === "rolledBack") {
            journal.transition(manifest.correlationId, "pending");
          }
        } catch (error) {
          if (error instanceof ProtocolError) {
            throw new FoundryBridgeError(error.code, error.message, {
              retryable: error.retryable,
              fieldPath: error.fieldPath,
            });
          }
          throw error;
        }
        const requestingClient = foundryClient
          .getCapabilityReport()
          .clients.filter((client) => client.lane === "gm" && client.isGM && client.optedIn)
          .sort(
            (left, right) =>
              left.connectedAt - right.connectedAt || left.clientId.localeCompare(right.clientId),
          )[0];
        if (!requestingClient) {
          journal.transition(manifest.correlationId, "rolledBack", { errorCode: "NOT_CONNECTED" });
          await foundryClient.recordAudit({
            timestamp: new Date().toISOString(),
            correlationId: manifest.correlationId,
            command: TRANSACTION_COMMANDS.EXECUTE,
            requestingUserId: null,
            effectiveUserId: null,
            executingClientId: null,
            outcome: "failed",
            operation: "compensatingTransaction",
            permissionDecision: {
              allowed: false,
              requiredPermission: "GAMEMASTER",
              reason: "NOT_CONNECTED",
            },
            mutationIds: [],
            errorCode: "NOT_CONNECTED",
          });
          throw new FoundryBridgeError(
            "NOT_CONNECTED",
            "No opted-in GM command lane is connected for the strict-compensation manifest.",
            { retryable: true, correlationId: manifest.correlationId },
          );
        }
        if (!requestingClient.capabilities.includes(TRANSACTION_COMMANDS.EXECUTE)) {
          journal.transition(manifest.correlationId, "rolledBack", {
            errorCode: "UNSUPPORTED_VERSION",
          });
          throw new FoundryBridgeError(
            "UNSUPPORTED_VERSION",
            "The connected GM client does not advertise the transaction command set.",
            { correlationId: manifest.correlationId },
          );
        }
        const idempotencyStoreKey = `transaction:${computeRevision(manifest.idempotencyKey)}`;
        const idempotencyInput = {
          worldId: manifest.worldId,
          rollbackPolicy: manifest.rollbackPolicy,
          operations: manifest.operations,
          failureInjection: manifest.failureInjection,
        };
        let idempotent;
        try {
          idempotent = await foundations.idempotency.execute<TransactionResult>(
            idempotencyStoreKey,
            idempotencyInput,
            () =>
              foundryClient.call<TransactionManifest, TransactionResult>(
                TRANSACTION_COMMANDS.EXECUTE,
                manifest,
                {
                  requestingUserId: requestingClient.userId,
                  correlationId: manifest.correlationId,
                  requireDurableAudit: true,
                  auditOperation: "compensatingTransaction",
                  suppressCompletionAudit: true,
                },
              ),
          );
        } catch (error) {
          const failureCode =
            error instanceof FoundryBridgeError || error instanceof ProtocolError
              ? error.code
              : "HANDLER_ERROR";
          await foundryClient.recordAudit({
            timestamp: new Date().toISOString(),
            correlationId: manifest.correlationId,
            command: TRANSACTION_COMMANDS.EXECUTE,
            requestingUserId: requestingClient.userId,
            effectiveUserId: requestingClient.userId,
            executingClientId: requestingClient.clientId,
            outcome: "failed",
            operation: "compensatingTransaction",
            permissionDecision: {
              allowed: false,
              requiredPermission: "GAMEMASTER",
              reason: failureCode,
            },
            mutationIds: [],
            errorCode: failureCode,
          });
          if (error instanceof FoundryBridgeError) {
            const verifiedRolledBack = error.details?.["persistentPartialSuccess"] === false;
            const definitelyPreCommit = new Set([
              "INVALID_PAYLOAD",
              "PERMISSION_DENIED",
              "NOT_FOUND",
              "STALE_REVISION",
              "UNSUPPORTED_VERSION",
              "UNSUPPORTED_TYPE",
              "IDEMPOTENCY_CONFLICT",
            ]).has(error.code);
            const recoveryRequired = !(verifiedRolledBack || definitelyPreCommit);
            journal.transition(
              manifest.correlationId,
              recoveryRequired ? "recoveryRequired" : "rolledBack",
              { errorCode: error.code },
            );
            if (!recoveryRequired) {
              foundations.idempotency.resolvePendingAsRolledBack(
                idempotencyStoreKey,
                idempotencyInput,
              );
            }
          }
          if (error instanceof ProtocolError) {
            journal.transition(
              manifest.correlationId,
              error.code === "INCOMPLETE_RESULT" ? "recoveryRequired" : "rolledBack",
              { errorCode: error.code },
            );
            throw new FoundryBridgeError(error.code, error.message, {
              retryable: error.retryable,
              fieldPath: error.fieldPath,
              correlationId: error.correlationId,
              details: error.details,
            });
          }
          throw error;
        }
        const mutationIds = idempotent.result.operations.map(({ documentId }) => documentId);
        await foundryClient.recordAudit({
          timestamp: new Date().toISOString(),
          correlationId: manifest.correlationId,
          command: TRANSACTION_COMMANDS.EXECUTE,
          requestingUserId: requestingClient.userId,
          effectiveUserId: requestingClient.userId,
          executingClientId: requestingClient.clientId,
          outcome: "succeeded",
          operation: "compensatingTransaction",
          permissionDecision: { allowed: true, requiredPermission: "GAMEMASTER" },
          mutationIds,
        });
        journal.transition(manifest.correlationId, "committed", {
          committedRevision: idempotent.result.committedRevision,
        });
        const result: TransactionExecutionResult = {
          ...idempotent.result,
          replayed: idempotent.replayed,
          executionContext: {
            clientId: requestingClient.clientId,
            userId: requestingClient.userId,
            foundryVersion: requestingClient.foundryVersion,
            systemId: requestingClient.systemId,
            systemVersion: requestingClient.systemVersion,
            moduleVersion: requestingClient.moduleVersion,
          },
        };
        return result;
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    {
      name: "foundry_get_transaction_status",
      description:
        "Reads the durable, payload-redacted state of one exact transaction ID, including explicit pending and recovery-required states after restart.",
      method: "get",
      path: "/transactions/:transactionId",
      inputSchema: transactionIdSchema,
      handler: ({ transactionId }: { transactionId: string }) => journal.get(transactionId),
      annotations: { readOnlyHint: true },
    },
    {
      name: "foundry_recover_transaction",
      description:
        "Retries the bounded in-memory compensation plan for a recovery-required transaction through the executing GM client. It fails explicitly if the browser restarted and lost that plan.",
      method: "post",
      path: "/transactions/:transactionId/recover",
      inputSchema: recoverySchema,
      handler: async (input: TransactionRecoveryInput, { foundryClient }) => {
        const record = journal.get(input.transactionId);
        if (record.state !== "recoveryRequired") {
          throw new FoundryBridgeError(
            "INVALID_PAYLOAD",
            "Only a recovery-required transaction can be recovered.",
            { fieldPath: "transactionId" },
          );
        }
        const recovered = await foundryClient.call<
          TransactionRecoveryInput,
          TransactionRecoveryResult
        >(TRANSACTION_COMMANDS.RECOVER, input, {
          correlationId: input.transactionId,
          requireDurableAudit: true,
          auditOperation: "transactionRecovery",
        });
        journal.transition(input.transactionId, "rolledBack");
        return recovered;
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
  ];
}

/** Test/backward-compatible descriptor catalog. Production root wiring must supply a durable journal. */
export const transactionEndpointDescriptors: AnyEndpointDescriptor[] =
  createTransactionEndpointDescriptors(new TransactionJournal(null));
