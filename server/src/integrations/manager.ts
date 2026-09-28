// Phase 32 — IntegrationManager: the detection/diffing brain.
//
// Deliberately dependency-free of Express/MCP (pure infra over
// `FoundryClient`, like `FoundryEventBus` is pure infra over
// `FoundryClient.onEvent()`) so it's unit-testable with a fake
// `FoundryClient` and no Express/MCP involved.
import { META_COMMANDS, type ModuleInfo, type SystemInfo } from "@foundry-local-api/shared";

import type { FoundryClient } from "../bridge/foundry-client.js";
import type { Integration } from "./types.js";
import { isVersionInRange } from "./version.js";

export type IntegrationChangeListener = (active: Integration[]) => void;

/**
 * Resolves the active optional integrations from the public system/module
 * snapshot. Kept pure so both the in-process bridge manager and the remote
 * HTTP-forwarding MCP process apply exactly the same detection/version rules.
 */
export function detectActiveIntegrations(
  system: SystemInfo,
  modules: ModuleInfo[],
  integrations: Integration[],
): Integration[] {
  const activeModules = modules.filter((module) => module.active);
  const activeModuleIds = activeModules.map((module) => module.id);

  return integrations.filter((integration) => {
    if (!integration.detect(system.id, activeModuleIds)) {
      return false;
    }

    const version =
      integration.kind === "system"
        ? system.version
        : activeModules.find((module) => module.id === integration.id)?.version;

    return (
      version === undefined ||
      isVersionInRange(version, integration.minVersion, integration.maxVersion)
    );
  });
}

export class IntegrationManager {
  private active: Integration[] = [];
  private readonly changeListeners = new Set<IntegrationChangeListener>();

  constructor(
    private readonly foundryClient: FoundryClient,
    private readonly integrations: Integration[],
  ) {}

  /** The current active set. Empty until the first successful `refresh()`. */
  getActive(): Integration[] {
    return this.active;
  }

  /** Registers a listener invoked with the new active array whenever the active set actually changes. Returns an unsubscribe function, mirroring `FoundryClient.onEvent`/`BridgeGateway.onMessage`'s Set-based idiom. */
  onChange(listener: IntegrationChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * Re-detects the active integration set against the currently connected
   * Foundry world. Intended to be called right after a bridge connection is
   * (re-)established (see server/src/index.ts's `gateway.onConnectionEstablished`
   * wiring) — the connected module is the only source of truth for which
   * system/modules are active.
   *
   * If `foundryClient.call()` throws (e.g. `NOT_CONNECTED` on a race between
   * a connection dropping and this being called), the error propagates —
   * the caller is responsible for catching/logging it, this method never
   * swallows it.
   */
  async refresh(): Promise<void> {
    const [system, modules] = await Promise.all([
      this.foundryClient.call<undefined, SystemInfo>(META_COMMANDS.SYSTEM),
      this.foundryClient.call<undefined, ModuleInfo[]>(META_COMMANDS.MODULES),
    ]);

    const nextActive = detectActiveIntegrations(system, modules, this.integrations);

    const previousIds = new Set(this.active.map((i) => i.id));
    const nextIds = new Set(nextActive.map((i) => i.id));
    const changed =
      previousIds.size !== nextIds.size || [...previousIds].some((id) => !nextIds.has(id));

    if (!changed) {
      return;
    }

    this.active = nextActive;
    for (const listener of this.changeListeners) {
      listener(this.active);
    }
  }
}
