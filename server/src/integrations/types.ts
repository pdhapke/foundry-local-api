// Phase 32 — Optional Integration Plugin Framework.
//
// An `Integration` is a bundle of endpoints that only exist when a specific
// game system or module is active in the connected Foundry world (e.g. the
// dnd5e-specific endpoints Phase 34 adds). Core endpoints (everything under
// `server/src/endpoints/`) never depend on this file — integrations are
// strictly additive and independently togglable, per PLAN.md's Part 2 intro.
import type { AnyEndpointDescriptor } from "../endpoints/types.js";

export interface Integration {
  /**
   * Stable package identity and REST namespace: every endpoint's `path`
   * must start with `/${id}` (mounted under `/api/integrations` by
   * ./router.ts, so the real path is `/api/integrations/<id>/...`). This is
   * deliberately independent from `toolPrefix`, since package ids may use
   * characters that are undesirable in portable MCP tool names.
   */
  id: string;
  /**
   * Optional MCP tool-name prefix. Defaults to `${id}_`; set it when the
   * stable package id and the public MCP namespace must differ. Prefixes are
   * validated with the integration registry before any production tools are
   * served.
   */
  toolPrefix?: string;
  kind: "system" | "module";
  /**
   * Whether this integration's target is active in the currently connected
   * world, given the active system id and the ids of every *active*
   * (installed-and-enabled) module. Called by IntegrationManager.refresh()
   * (./manager.ts) after every bridge (re)connection. This is the source of
   * truth for *whether* this integration matches — `minVersion`/
   * `maxVersion` below are an additional narrowing on top of a passing
   * `detect()`, never a substitute for it.
   */
  detect(activeSystemId: string, activeModuleIds: string[]): boolean;
  endpoints: AnyEndpointDescriptor[];
  /**
   * Inclusive lower bound (dotted-numeric, e.g. "3.10.0") on the matched
   * system's or module's own reported `version` (Phase 6's `SystemInfo`/
   * `ModuleInfo` — shared/src/meta.ts). Checked in addition to `detect()`
   * passing: a `detect()`-matching integration whose target's version falls
   * below `minVersion` (or above `maxVersion`) does not activate. Compared
   * with ./version.ts's `isVersionInRange`, which treats missing/
   * non-numeric segments as 0 and needs no third-party semver package.
   */
  minVersion?: string;
  /** Inclusive upper bound — see `minVersion` above. */
  maxVersion?: string;
}

/** Returns the MCP prefix declared by an integration, or its identity-based default. */
export function getIntegrationToolPrefix(integration: Integration): string {
  return integration.toolPrefix ?? `${integration.id}_`;
}
