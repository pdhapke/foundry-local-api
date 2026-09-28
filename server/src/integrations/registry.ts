// Phase 32 — the explicit, audit-friendly list of every known integration.
//
// Deliberately a plain array populated by hand, not auto-discovery (e.g.
// scanning subdirectories) — PLAN.md's Phase 32 spec calls for "one explicit
// list ... so the active set is easy to audit." Later phases (33+, starting
// with Phase 34's dnd5e integration) append entries here.
import { dnd5eIntegration } from "./dnd5e/index.js";
import { dttIntegration } from "./digital-tabletops/index.js";
import { trailsOfDestinyIntegration } from "./trails-of-destiny/index.js";
import { getIntegrationToolPrefix, type Integration } from "./types.js";

// Keep integration-owned MCP names conservative and portable across clients.
// The trailing underscore makes the namespace boundary unambiguous.
const TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9_]*_$/;

/**
 * Validates the complete optional-integration catalog before it is exposed
 * to the REST router or an MCP server. Iteration order is intentionally the
 * caller's array/descriptor order so a malformed registry always reports
 * the same first error.
 */
export function validateIntegrationRegistry(entries: Integration[]): Integration[] {
  const integrationIds = new Set<string>();
  const toolOwners = new Map<string, string>();

  for (const integration of entries) {
    if (integrationIds.has(integration.id)) {
      throw new Error(`Duplicate integration id '${integration.id}'`);
    }
    integrationIds.add(integration.id);

    const prefix = getIntegrationToolPrefix(integration);
    if (!TOOL_PREFIX_PATTERN.test(prefix)) {
      throw new Error(
        `Invalid MCP tool prefix '${prefix}' for integration '${integration.id}': expected lowercase letters, digits, or underscores, beginning with a letter and ending with '_'`,
      );
    }

    for (const descriptor of integration.endpoints) {
      if (!descriptor.name.startsWith(prefix)) {
        throw new Error(
          `MCP tool '${descriptor.name}' for integration '${integration.id}' must start with '${prefix}'`,
        );
      }

      const existingOwner = toolOwners.get(descriptor.name);
      if (existingOwner !== undefined) {
        throw new Error(
          `Duplicate integration MCP tool name '${descriptor.name}' in integrations '${existingOwner}' and '${integration.id}'`,
        );
      }
      toolOwners.set(descriptor.name, integration.id);
    }
  }

  return entries;
}

export const integrations: Integration[] = validateIntegrationRegistry([
  dnd5eIntegration,
  dttIntegration,
  trailsOfDestinyIntegration,
]);
