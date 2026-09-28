import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { allEndpointDescriptors } from "./index.js";

const REQUIRED_TOOLS = [
  "foundry_get_document_schema",
  "foundry_validate_document_data",
  "foundry_execute_as_user",
  "foundry_preflight_transaction",
  "foundry_execute_transaction",
  "foundry_get_transaction_status",
  "foundry_recover_transaction",
  "foundry_get_scene_fog",
  "foundry_update_scene_fog",
  "foundry_render_scene_snapshot",
  "foundry_get_token_visibility",
  "foundry_preload_scene",
  "foundry_get_client_readiness",
  "foundry_apply_client_viewport",
  "foundry_list_embedded_child",
  "foundry_get_embedded_child",
  "foundry_create_embedded_child",
  "foundry_update_embedded_child",
  "foundry_delete_embedded_child",
  "foundry_stat_asset",
  "foundry_move_asset",
  "foundry_delete_asset",
  "foundry_audit_campaign_references",
  "foundry_validate_token_path",
  "foundry_validate_wall_topology",
  "foundry_simulate_dnd5e_action",
  "foundry_record_movement_event",
  "foundry_get_movement_events",
] as const;

void describe("MCP requirement root registration", () => {
  void it("registers every requirement tool exactly once with REST wiring", () => {
    const names = allEndpointDescriptors.map(({ name }) => name);
    for (const required of REQUIRED_TOOLS) {
      assert.equal(names.filter((name) => name === required).length, 1, required);
      const descriptor = allEndpointDescriptors.find(({ name }) => name === required);
      assert.ok(descriptor?.method, `${required} method`);
      assert.ok(descriptor?.path, `${required} path`);
    }
    assert.equal(new Set(names).size, names.length, "global descriptor names must be unique");
  });
});
