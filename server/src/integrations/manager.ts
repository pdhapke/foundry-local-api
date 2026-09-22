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

    const activeModules = modules.filter((m) => m.active);
    const activeModuleIds = activeModules.map((m) => m.id);

    const nextActive = this.integrations.filter((integration) => {
      if (!integration.detect(system.id, activeModuleIds)) {
        return false;
      }

      // detect() passing only tells us *which* integration matched, not
      // its version — resolve that separately depending on `kind`.
      let version: string | undefined;
      if (integration.kind === "system") {
        // There is only ever one active system, so if detect() passed, it
        // matched the world's one active system.
        version = system.version;
      } else {
        const matchedModule = activeModules.find((m) => m.id === integration.id);
        // No matching module version found -> can't further restrict by
        // version, but detect() already passed, so this is not an error,
        // just a fallback (no minVersion/maxVersion enforcement possible).
        version = matchedModule?.version;
      }

      if (version === undefined) {
        return true;
      }
      return isVersionInRange(version, integration.minVersion, integration.maxVersion);
    });

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
