import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { allEndpointDescriptors } from "./index.js";

const REQUIRED_TOOLS = [
  "foundry_validate_acceptance_failures",
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
  "foundry_align_scene_grid",
  "foundry_preload_scene",
  "foundry_get_client_readiness",
  "foundry_apply_client_viewport",
  "foundry_reload_client",
  "foundry_adopt_gm_client_identity",
  "foundry_adopt_enrolled_client_identity",
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

const REQUIRED_CONCRETE_OUTPUTS = [
  "foundry_validate_acceptance_failures",
  "foundry_issue_bridge_enrollment",
  "foundry_get_bridge_enrollment_diagnostics",
  "foundry_render_scene_snapshot",
  "foundry_get_token_visibility",
  "foundry_align_scene_grid",
  "foundry_list_embedded_child",
  "foundry_get_embedded_child",
  "foundry_create_embedded_child",
  "foundry_update_embedded_child",
  "foundry_delete_embedded_child",
  "foundry_validate_token_path",
  "foundry_validate_wall_topology",
  "foundry_record_movement_event",
  "foundry_get_movement_events",
  "foundry_adopt_gm_client_identity",
  "foundry_adopt_enrolled_client_identity",
] as const;

// The older DM supplies these through the authenticated extension catalog.
// Static aliases would collide with its registration and disable the extension.
const AI_OWNED_EXTENSION_TOOLS = [
  "foundry_rollover_movement_store_generation",
  "foundry_list_ai_gm_deliveries",
  "foundry_get_ai_gm_delivery",
] as const;

void describe("MCP requirement root registration", () => {
  void it("reserves AI-owned aliases for the dynamic extension catalog", () => {
    for (const name of AI_OWNED_EXTENSION_TOOLS) {
      assert.equal(
        allEndpointDescriptors.some((descriptor) => descriptor.name === name),
        false,
        name,
      );
    }
  });
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

  void it("publishes concrete success contracts for the Gate 1 tool families", () => {
    for (const required of REQUIRED_CONCRETE_OUTPUTS) {
      const descriptor = allEndpointDescriptors.find(({ name }) => name === required);
      assert.ok(descriptor?.outputSchema, `${required} outputSchema`);
      const jsonSchema = descriptor.outputSchema.toJSONSchema();
      assert.equal(jsonSchema.type, "object", `${required} top-level output type`);
      assert.ok(
        jsonSchema.properties && Object.keys(jsonSchema.properties).length > 0,
        `${required} concrete output properties`,
      );
    }
  });
});
