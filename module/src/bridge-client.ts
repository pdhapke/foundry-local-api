// WebSocket bridge client: connects the in-Foundry module out to the local
// server process (server/, Phase 1+). The server-side `/bridge` WS gateway
// doesn't exist until Phase 3, so a live connection attempt made against
// today's server will fail and retry via the backoff loop below — that is
// expected until Phase 3 lands, not a bug in this file.

import type { BridgeRequest, BridgeResponse } from "@foundry-local-api/shared";
import { dispatch } from "./command-registry.js";

export const MODULE_ID = "foundry-local-api";
export const BRIDGE_URL_SETTING = "bridgeUrl";

/** Matches the server's Phase 1 default port (`server/src/config.ts`). */
export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:3939/bridge";

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

export interface BackoffOptions {
  /** Delay for the first reconnect attempt (attempt 0), before jitter. */
  baseDelayMs: number;
  /** Upper bound the exponential growth is capped at, before jitter. */
  maxDelayMs: number;
}

export const DEFAULT_BACKOFF_OPTIONS: BackoffOptions = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

/**
 * Pure exponential-backoff-with-jitter delay calculation, deliberately
 * extracted from {@link BridgeClient} so it can be unit-sanity-checked
 * without a real timer or socket.
 *
 * `attempt` is 0-based (0 = the first reconnect attempt after the initial
 * connection failure). Uses "full jitter": a uniformly random delay in
 * `[0, min(maxDelayMs, baseDelayMs * 2^attempt)]`, which avoids reconnect
 * storms while still capping the worst-case wait.
 */
export function computeBackoffDelayMs(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF_OPTIONS,
): number {
  const { baseDelayMs, maxDelayMs } = options;
  const cappedExponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt));
  return Math.floor(Math.random() * cappedExponential);
}

/** Registers the client-scope module setting that holds the bridge URL. */
export function registerBridgeSettings(): void {
  game.settings.register<string>(MODULE_ID, BRIDGE_URL_SETTING, {
    name: "Bridge Server URL",
    hint: "WebSocket URL of the local foundry-local-api server this module connects to.",
    scope: "client",
    config: true,
    type: String,
    default: DEFAULT_BRIDGE_URL,
  });
}

/** Reads the currently configured bridge URL from the module setting. */
export function getConfiguredBridgeUrl(): string {
  return game.settings.get<string>(MODULE_ID, BRIDGE_URL_SETTING);
}

/**
 * Manages a single reconnecting WebSocket connection to the bridge server,
 * dispatching every inbound {@link BridgeRequest} through the module's
 * command registry and sending the resulting {@link BridgeResponse} back.
 */
export class BridgeClient {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyClosed = false;

  constructor(
    private readonly getUrl: () => string,
    private readonly backoffOptions: BackoffOptions = DEFAULT_BACKOFF_OPTIONS,
  ) {}

  /** Current connection status, programmatically queryable. */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /** Opens the connection (and lets the reconnect loop keep it open). */
  connect(): void {
    this.manuallyClosed = false;
    this.openSocket();
  }

  /** Closes the connection and stops any pending reconnect attempt. */
  disconnect(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    console.log(`[${MODULE_ID}] bridge connection status: ${status}`);
  }

  private openSocket(): void {
    const url = this.getUrl();
    this.setStatus("connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.error(`[${MODULE_ID}] failed to open bridge socket`, err);
      this.setStatus("disconnected");
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.setStatus("connected");
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      void this.handleMessage(event);
    });

    socket.addEventListener("close", () => {
      this.socket = null;
      this.setStatus("disconnected");
      if (!this.manuallyClosed) {
        this.scheduleReconnect();
      }
    });

    socket.addEventListener("error", (event) => {
      // The "close" event that follows drives status change + reconnect
      // scheduling; this just gets the failure into the console.
      console.error(`[${MODULE_ID}] bridge socket error`, event);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    const delay = computeBackoffDelayMs(this.reconnectAttempt, this.backoffOptions);
    this.reconnectAttempt += 1;
    console.log(`[${MODULE_ID}] reconnecting to bridge in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    const raw = typeof event.data === "string" ? event.data : null;
    if (raw === null) {
      console.error(`[${MODULE_ID}] ignoring non-text bridge message`);
      return;
    }

    let request: BridgeRequest;
    try {
      request = JSON.parse(raw) as BridgeRequest;
    } catch (err) {
      console.error(`[${MODULE_ID}] failed to parse bridge message as JSON`, err);
      return;
    }

    const response: BridgeResponse = await dispatch(request);
    this.send(response);
  }

  private send(response: BridgeResponse): void {
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(response));
    }
  }
}
