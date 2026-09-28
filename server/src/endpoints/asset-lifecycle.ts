import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ASSET_COMMANDS,
  ProtocolError,
  type AssetReferenceResult,
  type MutationAuditRecord,
} from "@foundry-local-api/shared";
import type { AssetLifecycleService } from "../services/asset-lifecycle.js";
import type { AnyEndpointDescriptor } from "./types.js";
const location = { root: z.string().min(1).max(64), path: z.string().min(1).max(1024) };
const ownership = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("fixture"), testRunId: z.string().min(4).max(128) }),
  z.object({ scope: z.literal("campaign") }).strict(),
]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
function safeAssetError(error: unknown): never {
  if (error instanceof ProtocolError) throw error;
  throw new ProtocolError({
    code: "INCOMPLETE_RESULT",
    message: "The asset filesystem operation failed.",
    retryable: true,
  });
}
export function createAssetLifecycleEndpointDescriptors(
  service: AssetLifecycleService,
): AnyEndpointDescriptor[] {
  const mutate = async <TResult extends object>(
    command: string,
    input: Record<string, unknown>,
    foundryClient: Parameters<AnyEndpointDescriptor["handler"]>[1]["foundryClient"],
    operation: () => Promise<TResult>,
  ) => {
    const correlationId = randomUUID();
    const gm = foundryClient
      .getCapabilityReport()
      .clients.find((client) => client.lane === "gm" && client.isGM && client.optedIn);
    const base: Omit<MutationAuditRecord, "timestamp" | "outcome"> = {
      correlationId,
      command,
      requestingUserId: gm?.userId ?? null,
      effectiveUserId: gm?.userId ?? null,
      executingClientId: gm?.clientId ?? null,
      operation: command,
      payloadSummary: input,
      permissionDecision: {
        allowed: gm !== undefined,
        requiredPermission: "GM and server allowlisted asset scope",
        reason: gm ? "Connected GM lane and scoped path policy." : "No connected GM lane.",
      },
    };
    if (!gm)
      throw new ProtocolError({
        code: "NOT_CONNECTED",
        message: "Asset mutations require a connected opted-in GM lane.",
        retryable: true,
      });
    await foundryClient.recordAudit({
      ...base,
      timestamp: new Date().toISOString(),
      outcome: "started",
    });
    try {
      const result = await operation();
      await foundryClient.recordAudit({
        ...base,
        timestamp: new Date().toISOString(),
        outcome: "succeeded",
        mutationIds: [
          String((result as { target?: { path?: string } }).target?.path ?? input["path"] ?? ""),
        ].filter(Boolean),
      });
      return { ...result, auditCorrelationId: correlationId };
    } catch (error) {
      await foundryClient.recordAudit({
        ...base,
        timestamp: new Date().toISOString(),
        outcome: "failed",
        errorCode: error instanceof ProtocolError ? error.code : "HANDLER_ERROR",
      });
      safeAssetError(error);
    }
  };
  return [
    {
      name: "foundry_stat_asset",
      description:
        "Stats, SHA-256 hashes, and signature-validates exactly one path inside an allowlisted data root. A recognized signature is not a full codec decode.",
      method: "get",
      path: "/assets/stat",
      inputSchema: z.object(location).strict(),
      handler: async (input) => {
        try {
          return await service.inspect(input);
        } catch (error) {
          safeAssetError(error);
        }
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "foundry_move_asset",
      description:
        "Moves exactly one fixture- or campaign-owned asset with expected-hash, containment, collision, and reference reporting. It does not rewrite document references transactionally.",
      method: "post",
      path: "/assets/move",
      inputSchema: z
        .object({
          source: z.object(location),
          destination: z.object(location),
          expectedHash: hash,
          collisionPolicy: z.enum(["fail", "replace-same-hash"]),
          ownership,
        })
        .strict(),
      handler: async (input, { foundryClient, foundations }) => {
        let fixtureRegistryState: "source" | "destination" | undefined;
        if (input.ownership.scope === "fixture") {
          const run = foundations?.fixtures.get(input.ownership.testRunId);
          const sourceRecorded = run?.files.some(
            (file) =>
              file.root === input.source.root &&
              file.path === input.source.path &&
              file.sha256 === input.expectedHash,
          );
          const destinationRecorded = run?.files.some(
            (file) =>
              file.root === input.destination.root &&
              file.path === input.destination.path &&
              file.sha256 === input.expectedHash,
          );
          fixtureRegistryState = sourceRecorded
            ? "source"
            : destinationRecorded
              ? "destination"
              : undefined;
          if (!fixtureRegistryState)
            throw new ProtocolError({
              code: "PERMISSION_DENIED",
              message:
                "Fixture move requires an exact recorded source or replay destination root/path/hash.",
              retryable: false,
              fieldPath: "source.path",
            });
        }
        const references = (await foundryClient.call(ASSET_COMMANDS.REFERENCES, {
          path: input.source.path,
        })) as AssetReferenceResult;
        const result = await mutate("asset-move", input, foundryClient, () =>
          service.move(input, references),
        );
        if (input.ownership.scope === "fixture" && fixtureRegistryState === "source")
          foundations!.fixtures.moveFile(input.ownership.testRunId, input.source, {
            ...input.destination,
            sha256: input.expectedHash,
          });
        return result;
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    {
      name: "foundry_delete_asset",
      description:
        "Deletes exactly one unreferenced fixture- or campaign-owned asset with expected-hash protection. Already-absent is reported explicitly.",
      method: "delete",
      path: "/assets/delete",
      inputSchema: z
        .object({
          ...location,
          expectedHash: hash,
          ownership,
          requireUnreferenced: z.literal(true),
        })
        .strict(),
      handler: async (input, { foundryClient, foundations }) => {
        if (input.ownership.scope === "fixture") {
          const run = foundations?.fixtures.get(input.ownership.testRunId);
          const recorded = run?.files.some(
            (file) =>
              file.root === input.root &&
              file.path === input.path &&
              file.sha256 === input.expectedHash,
          );
          if (!recorded) {
            const current = await service.inspect(input);
            if (current.exists)
              throw new ProtocolError({
                code: "PERMISSION_DENIED",
                message: "Fixture deletion requires an exact recorded target root/path/hash.",
                retryable: false,
                fieldPath: "path",
              });
          }
        }
        const references = (await foundryClient.call(ASSET_COMMANDS.REFERENCES, {
          path: input.path,
        })) as AssetReferenceResult;
        const result = await mutate("asset-delete", input, foundryClient, () =>
          service.delete(input, references),
        );
        if (input.ownership.scope === "fixture")
          foundations!.fixtures.removeFile(input.ownership.testRunId, input);
        return result;
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
  ];
}
