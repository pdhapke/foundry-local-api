// FoundryClient (Phase 3): the abstraction route handlers call starting
// Phase 6 to round-trip a command through the bridge to the connected
// Foundry module and back. Built on top of BridgeGateway, which only knows
// about raw text messages and connection lifecycle — this class owns the
// request/response envelope (shared/src/protocol.ts), correlation ids, and
// per-call timeouts.
import { randomUUID } from "node:crypto";
import { currentTraceId, latencyEvent, nativeLatencyEvent, withLatencyTrace } from "../latency-trace.js";

import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeClientLane,
  type BridgeEventDelivery,
  type BridgeEventMessage,
  type BridgeRequest,
  type BridgeResponse,
  type CapabilityReport,
  type MutationAuditRecord,
} from "@foundry-local-api/shared";

import { FoundryBridgeError, normalizeBridgeErrorCode } from "./errors.js";
import type { BridgeClientSelector, BridgeGateway } from "./gateway.js";

export interface FoundryClientEventMetadata {
  clientId: string;
  userId: string;
  lane: BridgeClientLane;
  delivery?: BridgeEventDelivery;
}

export type FoundryClientEventListener = (
  event: string,
  payload: unknown,
  metadata: FoundryClientEventMetadata,
) => void;

export interface FoundryClientOptions {
  /** Default per-call timeout, used when `call()` isn't given an override. */
  defaultTimeoutMs: number;
  auditSink?: ((record: MutationAuditRecord) => void | Promise<void>) | undefined;
  serverVersion?: string | undefined;
}

interface PendingCall {
  traceId: string | undefined;
  started: number;
  resolve: (result: unknown) => void;
  reject: (err: FoundryBridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
  clientId: string;
  command: string;
  correlationId: string;
  requestingUserId: string | null;
  effectiveUserId: string | null;
  suppressCompletionAudit: boolean;
  auditOperation: string | undefined;
}

export interface FoundryCallOptions {
  timeoutMs?: number;
  clientId?: string;
  userId?: string;
  lane?: BridgeClientLane;
  requestingUserId?: string | null;
  correlationId?: string;
  /** Refuse dispatch if the durable started record cannot be written. */
  requireDurableAudit?: boolean;
  /** A higher-level validator will write the correlated terminal audit record. */
  suppressCompletionAudit?: boolean;
  auditOperation?: string;
  /**
   * Explicit secrecy-safe projection for the started audit record. When set,
   * the raw command payload is never handed to any audit sink.
   */
  auditPayloadSummary?: unknown;
}

export class FoundryClient {
  private readonly pending = new Map<string, PendingCall>();
  private readonly eventListeners = new Set<FoundryClientEventListener>();
  private readonly liveVerifiedCommands = new Set<string>();

  constructor(
    private readonly gateway: BridgeGateway,
    private readonly options: FoundryClientOptions,
  ) {
    this.gateway.onMessage((clientId, raw) => this.handleMessage(clientId, raw));
    this.gateway.onConnectionLost((client) => this.rejectPendingForClient(client.clientId));
  }

  reserveClientIdentity(
    desiredClientId: string,
    ownerClientId: string,
    binding: {
      expectedUserId: string;
      expectedLane: "gm" | "player" | "tv";
      ttlMs: number;
    },
  ): string | null {
    return this.gateway.reserveClientIdentity(desiredClientId, ownerClientId, binding);
  }

  releaseClientIdentity(desiredClientId: string, ownerClientId: string): void {
    this.gateway.releaseClientIdentity(desiredClientId, ownerClientId);
  }

  /**
   * Sends `{type, payload}` to the currently connected Foundry module and
   * resolves with its `result`, or rejects with a `FoundryBridgeError`.
   *
   * Rejects immediately (no timeout wait) if nothing is connected right
   * now. Otherwise rejects on timeout, on an explicit `ok:false` response,
   * or immediately if the connection drops while the call is still
   * in-flight.
   */
  async call<TPayload = unknown, TResult = unknown>(
    type: string,
    payload?: TPayload,
    options?: FoundryCallOptions,
  ): Promise<TResult> {
    const selector: BridgeClientSelector = {
      ...(options?.clientId ? { clientId: options.clientId } : {}),
      ...(options?.userId ? { userId: options.userId } : {}),
      ...(options?.lane ? { lane: options.lane } : {}),
    };
    const executingClient = this.gateway.getClient(selector);
    if (!executingClient) {
      throw new FoundryBridgeError(
        "NOT_CONNECTED",
        options?.userId
          ? `No opted-in Foundry client is connected for user "${options.userId}".`
          : "No opted-in Foundry client is currently connected on the requested bridge lane.",
        { retryable: true, details: { selector } },
      );
    }

    const id = randomUUID();
    const correlationId = options?.correlationId ?? id;
    const requestingUserId =
      options?.requestingUserId ?? (executingClient.isGM ? executingClient.userId : null);
    const timeoutMs = options?.timeoutMs ?? this.options.defaultTimeoutMs;
    const request: BridgeRequest<TPayload> =
      payload === undefined ? { id, type } : { id, type, payload };
    if (currentTraceId()) request.traceId = currentTraceId()!;

    const startedAudit: MutationAuditRecord = {
      timestamp: new Date().toISOString(),
      correlationId,
      command: type,
      requestingUserId,
      effectiveUserId: executingClient.userId,
      executingClientId: executingClient.clientId,
      outcome: "started",
      ...(options?.auditOperation ? { operation: options.auditOperation } : {}),
      payloadSummary:
        options && Object.prototype.hasOwnProperty.call(options, "auditPayloadSummary")
          ? options.auditPayloadSummary
          : payload,
    };
    if (options?.requireDurableAudit === true) {
      await this.emitAudit(startedAudit, true);
    } else {
      void this.emitAudit(startedAudit);
    }

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        if (entry && !entry.suppressCompletionAudit) {
          void this.emitAudit({
            timestamp: new Date().toISOString(),
            correlationId: entry.correlationId,
            command: entry.command,
            requestingUserId: entry.requestingUserId,
            effectiveUserId: entry.effectiveUserId,
            executingClientId: entry.clientId,
            outcome: "failed",
            ...(entry.auditOperation ? { operation: entry.auditOperation } : {}),
            errorCode: "TIMEOUT",
          });
        }
        reject(
          new FoundryBridgeError(
            "TIMEOUT",
            `Bridge call "${type}" (id ${id}) timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        traceId: currentTraceId(),
        started: performance.now(),
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
        clientId: executingClient.clientId,
        command: type,
        correlationId,
        requestingUserId,
        effectiveUserId: executingClient.userId,
        suppressCompletionAudit: options?.suppressCompletionAudit === true,
        auditOperation: options?.auditOperation,
      });

      const sent = this.gateway.send(JSON.stringify(request), {
        clientId: executingClient.clientId,
      });
      latencyEvent(`bridge:${type}:dispatch`);
      if (!sent) {
        // Connection dropped between the isConnected() check above and now
        // (e.g. a concurrent disconnect). Fail the same way as the
        // up-front check rather than waiting out the timeout.
        clearTimeout(timer);
        this.pending.delete(id);
        if (options?.suppressCompletionAudit !== true) {
          void this.emitAudit({
            timestamp: new Date().toISOString(),
            correlationId,
            command: type,
            requestingUserId,
            effectiveUserId: executingClient.userId,
            executingClientId: executingClient.clientId,
            outcome: "failed",
            ...(options?.auditOperation ? { operation: options.auditOperation } : {}),
            errorCode: "NOT_CONNECTED",
          });
        }
        reject(
          new FoundryBridgeError(
            "NOT_CONNECTED",
            "No Foundry client is currently connected to the bridge.",
          ),
        );
      }
    });
  }

  getCapabilityReport(): CapabilityReport {
    const clients = this.gateway.listClients();
    const gmConnected = clients.some((client) => client.lane === "gm" && client.optedIn);
    const commandConnected = (command: string, lane?: BridgeClientLane): boolean =>
      clients.some(
        (client) =>
          client.optedIn &&
          (lane === undefined || client.lane === lane) &&
          client.capabilities.includes(command),
      );
    const commandsConnected = (commands: string[], lane?: BridgeClientLane): boolean =>
      commands.every((command) => commandConnected(command, lane));
    const commandsVerified = (commands: string[]): boolean =>
      commands.every((command) => this.liveVerifiedCommands.has(command));
    return {
      generatedAt: Date.now(),
      serverVersion: this.options.serverVersion ?? "unknown",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      clients,
      capabilities: [
        {
          id: "track0.protocol-negotiation",
          state: "supported",
          connected: clients.length > 0,
          liveVerified: clients.length > 0,
        },
        {
          id: "track0.gm-command-lane",
          state: "supported",
          connected: gmConnected,
          liveVerified: gmConnected,
        },
        {
          id: "track0.player-command-lane",
          state: "supported",
          connected: clients.some((client) => client.lane === "player" && client.optedIn),
          liveVerified: clients.some((client) => client.lane === "player" && client.optedIn),
          notes: ["Requires explicit per-client opt-in."],
        },
        {
          id: "mcp-req-002.effective-user-execution",
          state: "supported",
          connected: commandConnected("effectiveUserExecute", "player"),
          liveVerified: this.liveVerifiedCommands.has("effectiveUserExecute"),
          notes: ["Each bounded operation still requires separate acceptance evidence."],
        },
        {
          id: "mcp-req-003.schema-discovery-validation",
          state: "supported",
          connected:
            commandConnected("schemaDiscover", "gm") && commandConnected("schemaValidate", "gm"),
          liveVerified:
            this.liveVerifiedCommands.has("schemaDiscover") &&
            this.liveVerifiedCommands.has("schemaValidate"),
        },
        {
          id: "mcp-req-004.compensating-transactions",
          state: "partial",
          connected: commandConnected("transactionExecute", "gm"),
          liveVerified: this.liveVerifiedCommands.has("transactionExecute"),
          notes: [
            "Strict verified compensation is not database isolation; browser crashes and observed hook side effects can require manual recovery.",
          ],
        },
        {
          id: "mcp-req-001.fog-exploration",
          state: "supported",
          connected: commandsConnected(["fogExplorationGet", "fogExplorationUpdate"], "gm"),
          liveVerified: commandsVerified(["fogExplorationGet", "fogExplorationUpdate"]),
        },
        {
          id: "mcp-req-005.player-rendering-visibility",
          state: "partial",
          connected: commandsConnected(["sceneRenderSnapshot", "sceneVisibilityInspect"]),
          liveVerified: commandsVerified(["sceneRenderSnapshot", "sceneVisibilityInspect"]),
          notes: [
            "Structured player-context visibility, bounded redaction, and typed incomplete/error outcomes are source-implemented.",
            "Acceptance still requires separate real GM and Izzy evidence for Regions, barriers, secret doors/exits, fog, light, darkness, vision, failures, and no persistence.",
          ],
        },
        {
          id: "mcp-req-006.tile-region-behavior-crud",
          state: "partial",
          connected: commandsConnected(
            [
              "embeddedChildList",
              "embeddedChildGet",
              "embeddedChildCreate",
              "embeddedChildUpdate",
              "embeddedChildDelete",
            ],
            "gm",
          ),
          liveVerified: commandsVerified([
            "embeddedChildList",
            "embeddedChildGet",
            "embeddedChildCreate",
            "embeddedChildUpdate",
            "embeddedChildDelete",
          ]),
          notes: [
            "Exact-subtype validation, full-candidate partial updates, dry-run diffs, replay, and compensation are source-implemented.",
            "Family-specific live CRUD, revision, rollback, warning, sibling, and unrelated-field preservation acceptance remains open.",
          ],
        },
        {
          id: "mcp-req-007.playlist-table-card-crud",
          state: "partial",
          connected: commandsConnected(
            [
              "embeddedChildList",
              "embeddedChildGet",
              "embeddedChildCreate",
              "embeddedChildUpdate",
              "embeddedChildDelete",
            ],
            "gm",
          ),
          liveVerified: commandsVerified([
            "embeddedChildList",
            "embeddedChildGet",
            "embeddedChildCreate",
            "embeddedChildUpdate",
            "embeddedChildDelete",
          ]),
          notes: [
            "Family-specific CRUD, rollback, secrecy, and sibling-preservation acceptance remains open.",
          ],
        },
        {
          id: "mcp-req-008.asset-lifecycle",
          state: "partial",
          connected: commandConnected("assets.references", "gm"),
          liveVerified: this.liveVerifiedCommands.has("assets.references"),
          notes: [
            "Filesystem operations require server-side fixture ownership evidence.",
            "Media metadata/decode and complete reference reporting remain open.",
          ],
        },
        {
          id: "mcp-req-009.reference-audit",
          state: "partial",
          connected: commandConnected("references.audit", "gm"),
          liveVerified: this.liveVerifiedCommands.has("references.audit"),
          notes: [
            "The current graph scan is intentionally reported as incomplete and does not yet cover every ledger category.",
          ],
        },
        {
          id: "mcp-req-010.collision-topology",
          state: "partial",
          connected: commandsConnected(
            ["collisionValidateTokenPath", "collisionValidateWallTopology"],
            "gm",
          ),
          liveVerified: commandsVerified([
            "collisionValidateTokenPath",
            "collisionValidateWallTopology",
          ]),
          notes: [
            "Continuous swept token footprints, door states, first-collision evidence, and malformed-topology failures are source-implemented.",
            "The complete live fixture matrix and two independent unchanged-state reads remain open.",
          ],
        },
        {
          id: "mcp-req-011.client-readiness",
          state: "partial",
          connected: commandsConnected([
            "clientPreloadScene",
            "clientReadinessGet",
            "clientViewportApply",
          ]),
          liveVerified: commandsVerified([
            "clientPreloadScene",
            "clientReadinessGet",
            "clientViewportApply",
          ]),
          notes: [
            "Acknowledgement validation is implemented; live multi-client readiness and durable replay proof remain open.",
          ],
        },
        {
          id: "mcp-req-012.dnd5e-simulation",
          state: "partial",
          connected: commandConnected("dnd5eSimulateAction", "gm"),
          liveVerified: this.liveVerifiedCommands.has("dnd5eSimulateAction"),
          notes: [
            "The current deterministic projection is not yet equivalent to the full dnd5e activity engine.",
          ],
        },
        {
          id: "mcp-req-013.movement-events",
          state: "partial",
          connected: commandConnected("movementBuildEvent", "gm"),
          liveVerified: false,
          notes: [
            "Live verification requires an automatically forwarded durable movement event.",
            "Durable client outbox delivery, exact gaps, persistent deduplication, movement filters, Region geometry, and first-stop pending state are source-implemented.",
            "Real Izzy movement, disconnect/retry, corruption/restart recovery, suppression, and pending-adjudication acceptance remain open.",
          ],
        },
      ],
    };
  }

  /** Number of calls currently awaiting a response. Exposed for tests/diagnostics. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Registers a listener invoked for every inbound {@link BridgeEventMessage}
   * (Phase 26) — the module pushing an unsolicited Foundry hook firing,
   * unrelated to any pending `call()`. Returns an unsubscribe function.
   * Listener-set idiom mirrors `BridgeGateway.onMessage`/`onConnectionLost`
   * (server/src/bridge/gateway.ts), plus the unsubscribe return this phase's
   * consumer (the event bus) needs.
   */
  onEvent(listener: FoundryClientEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private handleMessage(clientId: string, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(
        "[bridge] received malformed (non-JSON) message, ignoring:",
        err instanceof Error ? err.message : err,
      );
      return;
    }

    // Checked before the response-shape parsing below: `kind: "event"` is a
    // discriminator no `BridgeRequest`/`BridgeResponse` has ever carried, so
    // it unambiguously routes to the event-listener path instead of falling
    // through to "unexpected shape, ignoring".
    if (isBridgeEventMessageShape(parsed)) {
      const executingClient = this.gateway.getClient({ clientId });
      if (!executingClient) return;
      const metadata: FoundryClientEventMetadata = {
        clientId,
        userId: executingClient.userId,
        lane: executingClient.lane,
        ...(parsed.delivery ? { delivery: parsed.delivery } : {}),
      };
      for (const listener of this.eventListeners) {
        listener(parsed.event, parsed.payload, metadata);
      }
      return;
    }

    if (!isBridgeResponseShape(parsed)) {
      console.error("[bridge] received message with unexpected shape, ignoring");
      return;
    }

    const response = parsed;
    const pending = this.pending.get(response.id);
    if (!pending) {
      console.warn("[bridge] received response for an unknown or already-resolved call, ignoring.");
      return;
    }
    if (pending.clientId !== clientId) {
      console.warn("[bridge] ignored response from the wrong client.");
      return;
    }

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.ok) {
      this.liveVerifiedCommands.add(pending.command);
      if (!pending.suppressCompletionAudit) {
        void this.emitAudit({
          timestamp: new Date().toISOString(),
          correlationId: pending.correlationId,
          command: pending.command,
          requestingUserId: pending.requestingUserId,
          effectiveUserId: pending.effectiveUserId,
          executingClientId: pending.clientId,
          outcome: "succeeded",
          ...(pending.auditOperation ? { operation: pending.auditOperation } : {}),
        });
      }
      withLatencyTrace(pending.traceId, () => {
        latencyEvent(`bridge:${pending.command}:ack`, performance.now() - pending.started, "returned");
        const native = response.latency;
        if (native && native.traceId === pending.traceId) {
          nativeLatencyEvent(`native:${pending.command}:clock`, native);
          latencyEvent(`native:${pending.command}:execution`, native.nativeExecutionMs, "returned");
          for (const span of Array.isArray(native.spans) ? native.spans.slice(0, 32) : [])
            if (span && ["preflight-read", "authoritative-readback", "mutation-and-readback"].includes(span.stage) && Number.isFinite(span.durationMs))
              latencyEvent(`native:${span.stage}`, span.durationMs, "returned");
        }
      });
      pending.resolve(response.result);
    } else {
      const code = normalizeBridgeErrorCode(response.error.code);
      if (!pending.suppressCompletionAudit) {
        void this.emitAudit({
          timestamp: new Date().toISOString(),
          correlationId: pending.correlationId,
          command: pending.command,
          requestingUserId: pending.requestingUserId,
          effectiveUserId: pending.effectiveUserId,
          executingClientId: pending.clientId,
          outcome: "failed",
          ...(pending.auditOperation ? { operation: pending.auditOperation } : {}),
          errorCode: code,
        });
      }
      pending.reject(
        new FoundryBridgeError(code, response.error.message, {
          retryable: response.error.retryable,
          fieldPath: response.error.fieldPath,
          correlationId: pending.correlationId,
          details: response.error.details,
        }),
      );
    }
  }

  private rejectPendingForClient(clientId: string): void {
    const error = new FoundryBridgeError(
      "NOT_CONNECTED",
      "The bridge connection was lost while this call was still pending.",
      { retryable: true },
    );
    for (const [id, entry] of this.pending) {
      if (entry.clientId !== clientId) continue;
      clearTimeout(entry.timer);
      if (!entry.suppressCompletionAudit) {
        void this.emitAudit({
          timestamp: new Date().toISOString(),
          correlationId: entry.correlationId,
          command: entry.command,
          requestingUserId: entry.requestingUserId,
          effectiveUserId: entry.effectiveUserId,
          executingClientId: entry.clientId,
          outcome: "failed",
          ...(entry.auditOperation ? { operation: entry.auditOperation } : {}),
          errorCode: "NOT_CONNECTED",
        });
      }
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  /** Writes a validated high-level audit record and fails closed if durability is unavailable. */
  async recordAudit(record: MutationAuditRecord): Promise<void> {
    await this.emitAudit(record, true);
  }

  private async emitAudit(record: MutationAuditRecord, required = false): Promise<void> {
    try {
      if (!this.options.auditSink) {
        if (required) throw new Error("No durable audit sink is configured.");
        return;
      }
      await this.options.auditSink(record);
    } catch (error) {
      if (required) {
        throw new FoundryBridgeError(
          "INCOMPLETE_RESULT",
          "The operation was not dispatched because its durable audit record could not be written.",
          { retryable: true, correlationId: record.correlationId },
        );
      }
      console.error("[audit] failed to persist bridge audit record:", error);
    }
  }
}

/** Narrow, defensive runtime check — inbound bridge messages are untrusted input. */
function isBridgeEventMessageShape(value: unknown): value is BridgeEventMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate["kind"] !== "event" || typeof candidate["event"] !== "string") return false;
  const delivery = candidate["delivery"];
  if (delivery === undefined) return true;
  if (typeof delivery !== "object" || delivery === null) return false;
  const record = delivery as Record<string, unknown>;
  const sender = record["sender"];
  return (
    typeof record["deliveryId"] === "string" &&
    Number.isSafeInteger(record["attempt"]) &&
    typeof sender === "object" &&
    sender !== null &&
    typeof (sender as Record<string, unknown>)["clientId"] === "string" &&
    typeof (sender as Record<string, unknown>)["userId"] === "string" &&
    ["gm", "player", "tv"].includes(String((sender as Record<string, unknown>)["lane"]))
  );
}

/** Narrow, defensive runtime check — inbound bridge messages are untrusted input. */
function isBridgeResponseShape(value: unknown): value is BridgeResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["id"] !== "string" || typeof candidate["ok"] !== "boolean") {
    return false;
  }
  if (candidate["ok"] === false) {
    const error = candidate["error"];
    return (
      typeof error === "object" &&
      error !== null &&
      typeof (error as Record<string, unknown>)["message"] === "string"
    );
  }
  return true;
}
