import type { BridgeClientLane } from "@foundry-local-api/shared";
export type BridgeStatus = "disconnected" | "connecting" | "connected";
/** Public, domain-independent browser extension contract. */
export interface BrowserBridgeApi {
  readonly version: 1;
  identity(): { clientId: string; userId: string; lane: BridgeClientLane; connected: boolean };
  registerDocumentGuard(name: string, guard: (context: unknown) => void): () => void;
  registerCommand(
    type: string,
    handler: (payload: unknown) => unknown | Promise<unknown>,
  ): () => void;
  sendEvent(name: string, payload: unknown): void;
  /** Direct, bounded private channel; never persisted or sent through event fanout. */
  sendPrivate(payload: unknown): void;
  onMessage(listener: (message: unknown) => boolean): () => void;
  onStatus(listener: (status: BridgeStatus) => void): () => void;
  onPump(listener: () => void): () => void;
}
