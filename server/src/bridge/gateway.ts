// Server-side WebSocket gateway for the Foundry module bridge (Phase 3).
//
// Mounted on the *existing* http.Server at path `/bridge` — this is
// deliberately not a second listening port, so the whole server process
// still binds exactly one TCP port (see server/src/config.ts HOST/PORT
// validation).
//
// Single active connection model
// --------------------------------
// At most one bridge connection is treated as "active" at a time. If a new
// connection arrives while one is already active, THE NEW CONNECTION WINS:
// the old socket is closed and any calls still pending against it are
// rejected immediately (via `onConnectionLost`).
//
// Why replace-on-new rather than reject-the-newcomer or run both: in
// practice the only realistic way a second connection attempt shows up here
// is the *same* Foundry world's browser tab reconnecting — a page refresh,
// the module hot-reloading, or the module's own reconnect-with-backoff loop
// (module/src/bridge-client.ts) firing again after a network blip, all
// before the old socket's `close` event has necessarily been observed
// server-side. It is not two independent Foundry worlds legitimately racing
// for the same local server; this server is meant to bridge exactly one
// running world at a time. Preferring the newest connection means a
// refreshed/reloaded client always wins immediately, with no risk of the
// bridge getting permanently wedged behind a zombie socket the server
// hasn't yet noticed is dead (which rejecting the newcomer could cause).
// "Last connection wins" is also the simplest policy to reason about and to
// document for operators.
import type { Server as HttpServer } from "node:http";

import { WebSocket, WebSocketServer, type RawData } from "ws";

export type BridgeMessageListener = (raw: string) => void;
/** Fired whenever the previously active connection stops being active, whether it closed on its own or was replaced by a new connection. */
export type BridgeConnectionLostListener = () => void;

export class BridgeGateway {
  private readonly wss: WebSocketServer;
  private active: WebSocket | null = null;
  private readonly messageListeners = new Set<BridgeMessageListener>();
  private readonly connectionLostListeners = new Set<BridgeConnectionLostListener>();

  constructor(httpServer: HttpServer) {
    this.wss = new WebSocketServer({ server: httpServer, path: "/bridge" });
    this.wss.on("connection", (socket: WebSocket) => this.handleConnection(socket));
  }

  /** Whether a bridge client is currently connected and able to receive messages. */
  isConnected(): boolean {
    return this.active !== null && this.active.readyState === WebSocket.OPEN;
  }

  /** Sends a raw (already-serialized) message to the active connection. Returns false if there is none. */
  send(raw: string): boolean {
    if (!this.isConnected()) {
      return false;
    }
    this.active?.send(raw);
    return true;
  }

  /** Registers a listener invoked with the raw text of every inbound message from the active connection. */
  onMessage(listener: BridgeMessageListener): void {
    this.messageListeners.add(listener);
  }

  /** Registers a listener invoked whenever the active connection is lost (closed or replaced). */
  onConnectionLost(listener: BridgeConnectionLostListener): void {
    this.connectionLostListeners.add(listener);
  }

  /** Closes any active connection and stops the underlying WebSocketServer. Part of graceful shutdown. */
  async close(): Promise<void> {
    for (const client of this.wss.clients) {
      client.terminate();
    }
    this.active = null;

    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private handleConnection(socket: WebSocket): void {
    this.replaceActive(socket);

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        console.warn("[bridge] ignoring unexpected binary message");
        return;
      }
      const raw = data.toString();
      for (const listener of this.messageListeners) {
        listener(raw);
      }
    });

    socket.on("close", () => {
      if (this.active === socket) {
        this.active = null;
        this.notifyConnectionLost();
      }
    });

    socket.on("error", (err: Error) => {
      console.error("[bridge] socket error:", err.message);
    });
  }

  /** Installs `socket` as the active connection, closing and evicting whatever was active before it. */
  private replaceActive(socket: WebSocket): void {
    const stale = this.active;

    // Swap `active` to the new socket *before* closing the stale one (and
    // before notifying listeners). The stale socket's own "close" handler
    // (registered in handleConnection) checks `this.active === socket`
    // before reacting, so once `this.active` no longer points at it, that
    // handler is a no-op when the close handshake eventually completes —
    // no need to strip its listeners. Deliberately NOT using
    // `removeAllListeners()` here: `ws` itself attaches an internal
    // "close" listener per-socket (to remove it from `wss.clients`), and
    // stripping all listeners would also silently delete that, leaving a
    // dead entry in `wss.clients` forever and wedging a future
    // `wss.close()` (it waits for every tracked client to emit "close").
    this.active = socket;

    if (stale !== null) {
      console.warn("[bridge] new connection replaced an already-active bridge connection");
      stale.close(1000, "Replaced by new bridge connection");
      this.notifyConnectionLost();
    }
  }

  private notifyConnectionLost(): void {
    for (const listener of this.connectionLostListeners) {
      listener();
    }
  }
}
