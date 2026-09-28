import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type {
  EffectiveUserCommandResult,
  EffectiveUserExecuteInput,
} from "@foundry-local-api/shared";

import { FoundryBridgeError } from "../bridge/errors.js";
import type { FoundryCallOptions, FoundryClient } from "../bridge/foundry-client.js";
import { registerMcpTools } from "./registry.js";
import { effectiveUserEndpointDescriptors, effectiveUserExecuteSchema } from "./effective-user.js";

const input: EffectiveUserExecuteInput = {
  effectiveUserId: "player-1",
  operation: { kind: "inspectActorControl", actorId: "actor-1" },
};

const client = (overrides: Record<string, unknown> = {}) => ({
  clientId: "player-client-1",
  userId: "player-1",
  userName: "Player",
  isGM: false,
  lane: "player" as const,
  optedIn: true,
  protocolVersion: 2,
  foundryVersion: "14.368",
  systemId: "dnd5e",
  systemVersion: "6.0.3",
  moduleVersion: "0.1.0",
  transport: "websocket" as const,
  connectedAt: 100,
  lastSeenAt: 100,
  capabilities: ["effectiveUserExecute"],
  ...overrides,
});

const gmClient = (overrides: Record<string, unknown> = {}) =>
  client({
    clientId: "gm-client-1",
    userId: "gm-requester",
    userName: "GM",
    isGM: true,
    lane: "gm",
    connectedAt: 200,
    lastSeenAt: 200,
    ...overrides,
  });

const commandResult: EffectiveUserCommandResult = {
  effectiveUserId: "player-1",
  operation: "inspectActorControl",
  permissionDecision: { allowed: true, requiredPermission: "OWNER" },
  mutationIds: [],
  data: {
    kind: "actorControl",
    actorId: "actor-1",
    name: "Fixture Actor",
    canObserve: true,
    canControl: true,
    revision: "a".repeat(64),
  },
};

function fakeFoundryClient(
  clients: ReturnType<typeof client>[],
  call: FoundryClient["call"] = (() => Promise.resolve(commandResult)) as FoundryClient["call"],
  auditRecords: unknown[] = [],
): FoundryClient {
  return {
    getCapabilityReport: () => ({
      generatedAt: 1,
      serverVersion: "0.0.1",
      protocolVersion: 2,
      clients,
      capabilities: [],
    }),
    call,
    recordAudit: (record: unknown) => {
      auditRecords.push(record);
      return Promise.resolve();
    },
  } as unknown as FoundryClient;
}

async function execute(foundryClient: FoundryClient, request = input) {
  const descriptor = effectiveUserEndpointDescriptors[0];
  assert.ok(descriptor);
  return descriptor.handler(request, { foundryClient });
}

void describe("effective-user endpoint", () => {
  void it("routes to the exact newest opted-in player client and returns complete audit identity", async () => {
    const auditRecords: unknown[] = [];
    let captured:
      { type: string; payload: unknown; options: FoundryCallOptions | undefined } | undefined;
    const foundryClient = fakeFoundryClient(
      [
        gmClient(),
        client({ clientId: "older", connectedAt: 1 }),
        client({ clientId: "newer", connectedAt: 2 }),
      ],
      ((type: string, payload: unknown, options?: FoundryCallOptions) => {
        captured = { type, payload, options };
        return Promise.resolve(commandResult);
      }) as FoundryClient["call"],
      auditRecords,
    );

    const result = (await execute(foundryClient)) as Record<string, unknown>;
    assert.equal(captured?.type, "effectiveUserExecute");
    assert.deepEqual(captured?.payload, { ...input, requestingUserId: "gm-requester" });
    assert.equal(captured?.options?.clientId, "newer");
    assert.equal(captured?.options?.userId, "player-1");
    assert.equal(captured?.options?.lane, "player");
    assert.equal(captured?.options?.requestingUserId, "gm-requester");
    assert.equal(captured?.options?.correlationId, result["auditCorrelationId"]);
    assert.equal(captured?.options?.requireDurableAudit, true);
    assert.equal(captured?.options?.suppressCompletionAudit, true);
    assert.deepEqual(result["executingClient"], {
      clientId: "newer",
      lane: "player",
      foundryVersion: "14.368",
      systemId: "dnd5e",
      systemVersion: "6.0.3",
      moduleVersion: "0.1.0",
    });
    assert.equal(result["requestingUserId"], "gm-requester");
    assert.equal(result["effectiveUserId"], "player-1");
    assert.deepEqual(result["permissionDecision"], {
      allowed: true,
      requiredPermission: "OWNER",
    });
    assert.deepEqual(result["mutationIds"], []);
    assert.equal(auditRecords.length, 1);
    assert.deepEqual(auditRecords[0], {
      timestamp: (auditRecords[0] as { timestamp: string }).timestamp,
      correlationId: result["auditCorrelationId"],
      command: "effectiveUserExecute",
      requestingUserId: "gm-requester",
      effectiveUserId: "player-1",
      executingClientId: "newer",
      outcome: "succeeded",
      operation: "inspectActorControl",
      permissionDecision: { allowed: true, requiredPermission: "OWNER" },
      mutationIds: [],
    });
  });

  void it("returns typed failures for disconnected and non-consenting players", async () => {
    const auditRecords: Array<Record<string, unknown>> = [];
    await assert.rejects(
      execute(fakeFoundryClient([gmClient()], undefined, auditRecords)),
      (error: unknown) =>
        error instanceof FoundryBridgeError && error.code === "NOT_CONNECTED" && error.retryable,
    );
    await assert.rejects(
      execute(fakeFoundryClient([gmClient(), client({ optedIn: false })], undefined, auditRecords)),
      (error: unknown) =>
        error instanceof FoundryBridgeError &&
        error.code === "PERMISSION_DENIED" &&
        error.message.includes("opted in"),
    );
    assert.equal(auditRecords.length, 2);
    assert.deepEqual(
      auditRecords.map((record) => ({
        outcome: record["outcome"],
        permissionDecision: record["permissionDecision"],
        mutationIds: record["mutationIds"],
        errorCode: record["errorCode"],
      })),
      [
        {
          outcome: "failed",
          permissionDecision: {
            allowed: false,
            requiredPermission: "OWNER",
            reason: "NOT_CONNECTED",
          },
          mutationIds: [],
          errorCode: "NOT_CONNECTED",
        },
        {
          outcome: "failed",
          permissionDecision: {
            allowed: false,
            requiredPermission: "OWNER",
            reason: "PERMISSION_DENIED",
          },
          mutationIds: [],
          errorCode: "PERMISSION_DENIED",
        },
      ],
    );
  });

  void it("refuses GM and TV lane substitution before dispatch", async () => {
    let calls = 0;
    const call = (() => {
      calls += 1;
      return Promise.resolve(commandResult);
    }) as FoundryClient["call"];
    await assert.rejects(
      execute(fakeFoundryClient([gmClient(), client({ isGM: true, lane: "gm" })], call)),
      (error: unknown) => error instanceof FoundryBridgeError && error.code === "PERMISSION_DENIED",
    );
    await assert.rejects(
      execute(fakeFoundryClient([gmClient(), client({ lane: "tv" })], call)),
      (error: unknown) => error instanceof FoundryBridgeError && error.code === "PERMISSION_DENIED",
    );
    assert.equal(calls, 0);
  });

  void it("derives the requester from and requires an opted-in GM lane", async () => {
    let calls = 0;
    const call = (() => {
      calls += 1;
      return Promise.resolve(commandResult);
    }) as FoundryClient["call"];
    await assert.rejects(
      execute(fakeFoundryClient([client()], call)),
      (error: unknown) =>
        error instanceof FoundryBridgeError &&
        error.code === "NOT_CONNECTED" &&
        error.message.includes("GM command lane"),
    );
    assert.equal(calls, 0);
  });

  void it("preserves a player-side permission denial without substituting the GM lane", async () => {
    const auditRecords: Array<Record<string, unknown>> = [];
    const denial = new FoundryBridgeError(
      "PERMISSION_DENIED",
      "Document is unavailable to the effective user.",
      { correlationId: "audit-1" },
    );
    await assert.rejects(
      execute(
        fakeFoundryClient(
          [gmClient(), client()],
          (() => Promise.reject(denial)) as FoundryClient["call"],
          auditRecords,
        ),
      ),
      (error: unknown) =>
        error instanceof FoundryBridgeError &&
        error.code === "PERMISSION_DENIED" &&
        error.message === denial.message &&
        error.correlationId !== "audit-1" &&
        error.correlationId === auditRecords.at(-1)?.["correlationId"],
    );
  });

  void it("projects the player response so unexpected secrets cannot cross the endpoint", async () => {
    const unsafeResult = {
      ...commandResult,
      authorization: "Bearer hidden",
      data: { ...commandResult.data, apiKey: "hidden-key", system: { private: true } },
    };
    const result = await execute(
      fakeFoundryClient([gmClient(), client()], (() =>
        Promise.resolve(unsafeResult)) as FoundryClient["call"]),
    );
    const encoded = JSON.stringify(result);
    assert.equal(encoded.includes("Bearer hidden"), false);
    assert.equal(encoded.includes("hidden-key"), false);
    assert.equal(encoded.includes("private"), false);
  });

  void it("rejects arbitrary command/JavaScript injection and unallowlisted document types", () => {
    assert.equal(
      effectiveUserExecuteSchema.safeParse({
        ...input,
        command: "documentDelete",
        operation: { kind: "runJavaScript", source: "game.user.update({role:4})" },
      }).success,
      false,
    );
    assert.equal(
      effectiveUserExecuteSchema.safeParse({
        ...input,
        operation: { kind: "inspectActorControl", actorId: "actor", command: "userSetRole" },
      }).success,
      false,
    );
    for (const operation of [
      { kind: "inspectActorControl", actorId: "actor" },
      { kind: "readJournalContent", journalEntryId: "journal", pageId: "page" },
      { kind: "inspectSceneToken", sceneId: "scene", tokenId: "token" },
      { kind: "inspectNoteAccess", sceneId: "scene", noteId: "note" },
    ]) {
      assert.equal(effectiveUserExecuteSchema.safeParse({ ...input, operation }).success, true);
    }
  });

  void it("rejects invalid or identity-mismatched client results", async () => {
    await assert.rejects(
      execute(
        fakeFoundryClient([gmClient(), client()], (() =>
          Promise.resolve({
            ...commandResult,
            effectiveUserId: "other",
          })) as FoundryClient["call"]),
      ),
      (error: unknown) => error instanceof FoundryBridgeError && error.code === "INCOMPLETE_RESULT",
    );
  });

  void it("can be registered as a single authenticated REST/MCP descriptor", () => {
    const server = new McpServer({ name: "effective-user-test", version: "1" });
    const tools = registerMcpTools(
      server,
      effectiveUserEndpointDescriptors,
      fakeFoundryClient([client()]),
    );
    assert.equal(tools.length, 1);
    assert.equal(effectiveUserEndpointDescriptors[0]?.method, "post");
    assert.equal(effectiveUserEndpointDescriptors[0]?.path, "/effective-users/execute");
    assert.equal(effectiveUserEndpointDescriptors[0]?.name, "foundry_execute_as_user");
    assert.equal(effectiveUserEndpointDescriptors[0]?.annotations?.readOnlyHint, false);
    assert.equal(effectiveUserEndpointDescriptors[0]?.annotations?.destructiveHint, true);
  });

  void it("accepts only the revision-guarded fixture owner action shape", () => {
    assert.equal(
      effectiveUserExecuteSchema.safeParse({
        effectiveUserId: "player-1",
        operation: {
          kind: "applyActorOwnerProbe",
          actorId: "actor-1",
          testRunId: "test-owner-action-0001",
          probeValue: "applied",
          expectedRevision: "a".repeat(64),
        },
      }).success,
      true,
    );
    assert.equal(
      effectiveUserExecuteSchema.safeParse({
        effectiveUserId: "player-1",
        operation: {
          kind: "applyActorOwnerProbe",
          actorId: "actor-1",
          testRunId: "production",
          probeValue: "applied",
          expectedRevision: "a".repeat(64),
        },
      }).success,
      false,
    );
  });
});
