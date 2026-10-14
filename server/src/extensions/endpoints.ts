import express, { type RequestHandler } from "express";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import type { FoundryEventBus } from "../events/event-bus.js";
import type { FoundationRuntime } from "../foundations/runtime.js";
import { allEndpointDescriptors } from "../endpoints/index.js";
import { mountRestEndpoints, registerMcpTools } from "../endpoints/registry.js";
import type { AnyEndpointDescriptor } from "../endpoints/types.js";
import { HttpError } from "../http-error.js";

/** Literal segments and whole named parameters only; no Express patterns. */
function isEndpointPath(path: string): boolean {
  if (path.length > 1024 || !path.startsWith("/")) return false;
  const segments = path.slice(1).split("/");
  if (segments.length > 32) return false;
  const parameters = new Set<string>();
  for (const segment of segments) {
    if (/^[A-Za-z0-9_-]{1,128}$/.test(segment)) continue;
    if (!/^:[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(segment) || parameters.has(segment)) return false;
    parameters.add(segment);
  }
  return true;
}

/** Domain-free dynamic catalog behind the ordinary administrative auth gates. */
export class ExtensionEndpointRegistry {
  private readonly groups = new Set<AnyEndpointDescriptor[]>();
  private readonly listeners = new Set<() => void>();
  private router = express.Router();
  readonly middleware: RequestHandler = (request, response, next) =>
    this.router(request, response, next);
  register(descriptors: AnyEndpointDescriptor[]): () => void {
    const existing = [...allEndpointDescriptors, ...this.snapshot()];
    const names = new Set(existing.map((descriptor) => descriptor.name));
    const paths = new Set(
      existing
        .filter((descriptor) => descriptor.path)
        .map((descriptor) => `${descriptor.method}:${descriptor.path}`),
    );
    for (const descriptor of descriptors) {
      const path = `${descriptor.method}:${descriptor.path}`;
      if (
        !/^[A-Za-z0-9_]{1,128}$/.test(descriptor.name) ||
        names.has(descriptor.name) ||
        (descriptor.path && (!isEndpointPath(descriptor.path) || paths.has(path)))
      )
        throw new Error("Extension endpoint is invalid or duplicated.");
      names.add(descriptor.name);
      if (descriptor.path) paths.add(path);
    }
    let active = true;
    const group = descriptors.map(
      (descriptor) =>
        ({
          ...descriptor,
          handler: (input, context) => {
            if (!active)
              throw new HttpError(503, "Extension unavailable.", "EXTENSION_UNAVAILABLE");
            return descriptor.handler(input, context);
          },
        }) satisfies AnyEndpointDescriptor,
    );
    this.groups.add(group);
    this.refresh();
    return () => {
      if (!active) return;
      active = false;
      this.groups.delete(group);
      this.refresh();
    };
  }
  snapshot(): AnyEndpointDescriptor[] {
    return [...this.groups].flat();
  }
  private refresh(): void {
    const router = express.Router();
    mountRestEndpoints(router, this.snapshot());
    this.router = router;
    for (const listener of this.listeners) listener();
  }
  bindMcp(
    server: McpServer,
    client: FoundryClient,
    eventBus?: FoundryEventBus,
    foundations?: FoundationRuntime,
  ): () => void {
    let tools: RegisteredTool[] = [];
    const refresh = () => {
      for (const tool of tools) tool.remove();
      tools = registerMcpTools(server, this.snapshot(), client, eventBus, foundations);
    };
    refresh();
    this.listeners.add(refresh);
    return () => {
      this.listeners.delete(refresh);
      for (const tool of tools) tool.remove();
      tools = [];
    };
  }
}
export const extensionEndpoints = new ExtensionEndpointRegistry();
