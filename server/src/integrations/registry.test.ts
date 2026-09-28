import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AnyEndpointDescriptor } from "../endpoints/types.js";
import { integrations, validateIntegrationRegistry } from "./registry.js";
import { getIntegrationToolPrefix, type Integration } from "./types.js";

function descriptor(name: string): AnyEndpointDescriptor {
  return {
    name,
    description: name,
    handler: () => undefined,
  };
}

function integration(id: string, names: string[], toolPrefix?: string): Integration {
  return {
    id,
    ...(toolPrefix === undefined ? {} : { toolPrefix }),
    kind: "system",
    detect: () => false,
    endpoints: names.map(descriptor),
  };
}

void describe("integration registry validation", () => {
  void it("keeps existing registrations valid and resolves default or explicit prefixes", () => {
    assert.doesNotThrow(() => validateIntegrationRegistry(integrations));
    assert.equal(getIntegrationToolPrefix(integration("dnd5e", [])), "dnd5e_");
    assert.equal(
      getIntegrationToolPrefix(integration("trails-of-destiny", [], "trails_")),
      "trails_",
    );
  });

  void it("accepts a hyphenated identity when its descriptors use a portable explicit prefix", () => {
    const trails = integration(
      "trails-of-destiny",
      ["trails_get_config", "trails_get_actor_sheet"],
      "trails_",
    );

    assert.deepEqual(validateIntegrationRegistry([trails]), [trails]);
  });

  void it("rejects invalid effective prefixes deterministically", () => {
    assert.throws(
      () =>
        validateIntegrationRegistry([
          integration("first", ["first_ok"]),
          integration("trails-of-destiny", ["trails_get_config"]),
          integration("later", ["later_ok"], "Later_"),
        ]),
      /Invalid MCP tool prefix 'trails-of-destiny_' for integration 'trails-of-destiny'/,
    );
  });

  void it("rejects a descriptor that does not use its integration's effective prefix", () => {
    assert.throws(
      () =>
        validateIntegrationRegistry([
          integration("trails-of-destiny", ["foundry_get_config"], "trails_"),
        ]),
      /MCP tool 'foundry_get_config'.*must start with 'trails_'/,
    );
  });

  void it("rejects duplicate tool names across integrations in stable encounter order", () => {
    assert.throws(
      () =>
        validateIntegrationRegistry([
          integration("alpha", ["shared_get_config"], "shared_"),
          integration("beta", ["shared_get_config"], "shared_"),
        ]),
      /Duplicate integration MCP tool name 'shared_get_config' in integrations 'alpha' and 'beta'/,
    );
  });
});
