// FoundryClient (Phase 3): the abstraction route handlers call starting
// Phase 6 to round-trip a command through the bridge to the connected
// Foundry module and back. Built on top of BridgeGateway, which only knows
// about raw text messages and connection lifecycle — this class owns the
// request/response envelope (shared/src/protocol.ts), correlation ids, and
// per-call timeouts.
import { randomUUID } from "node:crypto";

import type { BridgeEventMessage, BridgeRequest, BridgeResponse } from "@foundry-local-api/shared";

import { FoundryBridgeError, normalizeBridgeErrorCode } from "./errors.js";
import type { BridgeGateway } from "./gateway.js";

export type FoundryClientEventListener = (event: string, payload: unknown) => void;

export interface FoundryClientOptions {
  /** Default per-call timeout, used when `call()` isn't given an override. */
  defaultTimeoutMs: number;
}

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: FoundryBridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class FoundryClient {
  private readonly pending = new Map<string, PendingCall>();
  private readonly eventListeners = new Set<FoundryClientEventListener>();

  constructor(
    private readonly gateway: BridgeGateway,
    private readonly options: FoundryClientOptions,
  ) {
    this.gateway.onMessage((raw) => this.handleMessage(raw));
    this.gateway.onConnectionLost(() => this.rejectAllPending());
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
    options?: { timeoutMs?: number },
  ): Promise<TResult> {
    if (!this.gateway.isConnected()) {
      throw new FoundryBridgeError(
        "NOT_CONNECTED",
        "No Foundry client is currently connected to the bridge.",
      );
    }

    const id = randomUUID();
    const timeoutMs = options?.timeoutMs ?? this.options.defaultTimeoutMs;
    const request: BridgeRequest<TPayload> =
      payload === undefined ? { id, type } : { id, type, payload };

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new FoundryBridgeError(
            "TIMEOUT",
            `Bridge call "${type}" (id ${id}) timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });

      const sent = this.gateway.send(JSON.stringify(request));
      if (!sent) {
        // Connection dropped between the isConnected() check above and now
        // (e.g. a concurrent disconnect). Fail the same way as the
        // up-front check rather than waiting out the timeout.
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new FoundryBridgeError(
            "NOT_CONNECTED",
            "No Foundry client is currently connected to the bridge.",
          ),
        );
      }
    });
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

  private handleMessage(raw: string): void {
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
      for (const listener of this.eventListeners) {
        listener(parsed.event, parsed.payload);
      }
      return;
    }

    if (!isBridgeResponseShape(parsed)) {
      console.error("[bridge] received message with unexpected shape, ignoring:", raw);
      return;
    }

    const response = parsed;
    const pending = this.pending.get(response.id);
    if (!pending) {
      console.warn(
        `[bridge] received response for unknown or already-resolved call id "${response.id}", ignoring.`,
      );
      return;
    }

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.ok) {
      pending.resolve(response.result);
    } else {
      const code = normalizeBridgeErrorCode(response.error.code);
      pending.reject(new FoundryBridgeError(code, response.error.message));
    }
  }

  /** Rejects every currently pending call. Used when the active connection is lost. */
  private rejectAllPending(): void {
    if (this.pending.size === 0) {
      return;
    }
    const error = new FoundryBridgeError(
      "NOT_CONNECTED",
      "The bridge connection was lost while this call was still pending.",
    );
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}

/** Narrow, defensive runtime check — inbound bridge messages are untrusted input. */
function isBridgeEventMessageShape(value: unknown): value is BridgeEventMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate["kind"] === "event" && typeof candidate["event"] === "string";
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
