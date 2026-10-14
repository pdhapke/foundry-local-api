import { ProtocolError } from "@foundry-local-api/shared";
import { sequencedMovementEventOutputSchema } from "../endpoints/requirement-output-schemas.js";
import type { SequencedMovementEvent } from "@foundry-local-api/shared";
import type { ZodType } from "zod";
import type {
  MovementStoreDiagnostics,
  MovementEventStore,
} from "../events/movement-event-store.js";
import type { AnyEndpointDescriptor } from "../endpoints/types.js";
import { extensionEndpoints } from "./endpoints.js";
import { fileURLToPath } from "node:url";
import type { RequestHandler } from "express";
import type { ConnectedBridgeClient } from "@foundry-local-api/shared";
import type {
  BridgeClientSelector,
  BridgeGateway,
  PrivateBridgeHandler,
} from "../bridge/gateway.js";
import type { FoundryClient, FoundryClientEventMetadata } from "../bridge/foundry-client.js";

export interface ExtensionRoute {
  path: string;
  handler: RequestHandler;
}
export interface ApiExtensionContext {
  readonly version: 1;
  readonly runtimeRoot: URL;
  readonly moduleRoot: URL;
  readonly bindHost: string;
  readonly administrativeCredentialSha256: string;
  readonly movement: MovementExtensionAccess & { readonly outputSchema: ZodType };
  createProtocolError(body: ConstructorParameters<typeof ProtocolError>[0]): Error;
  registerEndpoints(descriptors: AnyEndpointDescriptor[]): () => void;
  readonly bridge: Pick<BridgeGateway, "getClient" | "getVerifiedFoundryIdentity" | "send">;
  call(command: string, payload: unknown, selector: BridgeClientSelector): Promise<unknown>;
  registerPrivateChannel(kind: string, handler: PrivateBridgeHandler): () => void;
  registerEventHandler(
    name: string,
    handler: (payload: unknown, metadata: FoundryClientEventMetadata) => void | Promise<void>,
  ): () => void;
  onConnectionEstablished(handler: (client: ConnectedBridgeClient) => void): () => void;
  onConnectionLost(handler: (client: ConnectedBridgeClient) => void): () => void;
  registerRoute(path: string, handler: RequestHandler): () => void;
  onShutdown(handler: () => void | Promise<void>): () => void;
}
export interface MovementExtensionAccess {
  readonly path: string;
  getStore(): MovementEventStore | undefined;
  diagnose(): MovementStoreDiagnostics;
  reloadStore(): void;
  onRecord(handler: (record: SequencedMovementEvent) => void): () => void;
}
export interface ExtensionHostOptions {
  gateway: BridgeGateway;
  foundryClient: FoundryClient;
  runtimeRoot: URL;
  moduleRoot: URL;
  bindHost: string;
  administrativeCredentialSha256: string;
  movement: MovementExtensionAccess;
}
/** Trusted local, explicitly configured extension code. No auto-discovery or domain dependency. */
export class ApiExtensionHost {
  private readonly events = new Map<
    string,
    (payload: unknown, metadata: FoundryClientEventMetadata) => void | Promise<void>
  >();
  private readonly routes = new Map<string, RequestHandler>();
  private readonly disposers: (() => void)[] = [];
  private readonly shutdownHandlers = new Set<() => void | Promise<void>>();
  private closed = false;
  private callsClosed = false;
  readonly context: ApiExtensionContext;
  constructor(options: ExtensionHostOptions) {
    const own = (dispose: () => void) => {
      this.disposers.push(dispose);
      return dispose;
    };
    const requireOpen = () => {
      if (this.closed) throw new Error("Extension host is closed.");
    };
    this.context = Object.freeze({
      version: 1 as const,
      runtimeRoot: options.runtimeRoot,
      moduleRoot: options.moduleRoot,
      bindHost: options.bindHost,
      administrativeCredentialSha256: options.administrativeCredentialSha256,
      createProtocolError: (body) => new ProtocolError(body),
      movement: Object.freeze({
        path: options.movement.path,
        outputSchema: sequencedMovementEventOutputSchema,
        diagnose: () => {
          requireOpen();
          return options.movement.diagnose();
        },
        getStore: () => {
          requireOpen();
          return options.movement.getStore();
        },
        reloadStore: () => {
          requireOpen();
          options.movement.reloadStore();
        },
        onRecord: (handler: (record: SequencedMovementEvent) => void) => {
          requireOpen();
          return own(options.movement.onRecord(handler));
        },
      }),
      registerEndpoints: (descriptors) => {
        requireOpen();
        return own(extensionEndpoints.register(descriptors));
      },
      bridge: Object.freeze({
        getClient: options.gateway.getClient.bind(options.gateway),
        getVerifiedFoundryIdentity: options.gateway.getVerifiedFoundryIdentity.bind(
          options.gateway,
        ),
        send: options.gateway.send.bind(options.gateway),
      }),
      call: (command, payload, selector) => {
        if (this.callsClosed) throw new Error("Extension host is closed.");
        return options.foundryClient.call(command, payload, selector);
      },
      registerPrivateChannel: (kind, handler) => {
        requireOpen();
        return own(options.gateway.registerPrivateChannel(kind, handler));
      },
      registerEventHandler: (name, handler) => {
        requireOpen();
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(name) || this.events.has(name))
          throw new Error("Extension event registration is invalid or duplicated.");
        this.events.set(name, handler);
        return own(() => {
          if (this.events.get(name) === handler) this.events.delete(name);
        });
      },
      onConnectionEstablished: (handler) => {
        requireOpen();
        return own(options.gateway.onConnectionEstablished(handler));
      },
      onConnectionLost: (handler) => {
        requireOpen();
        return own(options.gateway.onConnectionLost(handler));
      },
      registerRoute: (path, handler) => {
        requireOpen();
        if (
          !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path) ||
          /^\/(?:api|mcp|health|bridge)(?:\/|$)/.test(path) ||
          this.routes.has(path)
        )
          throw new Error("Extension route registration is invalid or duplicated.");
        this.routes.set(path, handler);
        return own(() => {
          if (this.routes.get(path) === handler) this.routes.delete(path);
        });
      },
      onShutdown: (handler) => {
        requireOpen();
        this.shutdownHandlers.add(handler);
        return own(() => {
          this.shutdownHandlers.delete(handler);
        });
      },
    } satisfies ApiExtensionContext);
  }
  routeSnapshot(): ExtensionRoute[] {
    // Dynamic lookup makes disposal revoke already mounted routes immediately.
    return [...this.routes.keys()].map((path) => ({
      path,
      handler: (request, response, next) => {
        const handler = !this.closed && this.routes.get(path);
        if (!handler) {
          response.status(503).json({ error: "Extension unavailable." });
          return;
        }
        handler(request, response, next);
      },
    }));
  }
  consumeEvent(name: string, payload: unknown, metadata: FoundryClientEventMetadata): boolean {
    const handler = !this.closed && this.events.get(name);
    if (!handler) return false;
    try {
      void Promise.resolve(handler(payload, metadata)).catch(() => undefined);
    } catch {
      /* Extension errors never expose payloads. */
    }
    return true;
  }
  async load(
    specification: string | undefined,
    importer: (url: string) => Promise<unknown> = (url) => import(url),
  ): Promise<void> {
    try {
      const urls = parseExtensionUrls(specification);
      for (const url of urls) {
        const module = (await importer(url)) as { registerExtension?: unknown };
        if (typeof module?.registerExtension !== "function")
          throw new Error("Extension factory missing.");
        await module.registerExtension(this.context);
      }
    } catch {
      await this.shutdown();
      throw new Error("Configured API extension could not be loaded.");
    }
  }
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Revoke route/event access before awaiting extension lifecycle cleanup.
    this.events.clear();
    this.routes.clear();
    const handlers = [...this.shutdownHandlers];
    let disposalFailed = false;
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        disposalFailed = true;
      }
    }
    const results = await Promise.allSettled(
      handlers.map((handler) => Promise.resolve().then(handler)),
    );
    this.callsClosed = true;
    if (disposalFailed || results.some((result) => result.status === "rejected"))
      throw new Error("Extension shutdown incomplete.");
  }
}
export function parseExtensionUrls(specification: string | undefined): string[] {
  if (!specification) return [];
  const values: unknown = JSON.parse(specification);
  if (!Array.isArray(values) || values.length > 16)
    throw new Error("Invalid extension configuration.");
  const urls = values.map((value) => {
    if (typeof value !== "string" || !value.startsWith("file:///"))
      throw new Error("Invalid extension URL.");
    const url = new URL(value);
    if (
      url.protocol !== "file:" ||
      url.hostname ||
      url.search ||
      url.hash ||
      !/\.(?:mjs|js)$/.test(url.pathname)
    )
      throw new Error("Invalid extension URL.");
    fileURLToPath(url);
    return url.href;
  });
  if (new Set(urls).size !== urls.length) throw new Error("Duplicate extension URL.");
  return urls;
}
