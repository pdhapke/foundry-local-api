import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cloneSchemaCandidate,
  stableSchemaValue,
  validateDiscoveredFields,
  type DiscoveredSchemaField,
} from "./schema-discovery.js";

const fields: DiscoveredSchemaField[] = [
  { path: "name", type: "StringField", required: true, nullable: false, hasDefault: false },
  {
    path: "type",
    type: "StringField",
    required: true,
    nullable: false,
    hasDefault: false,
    choices: ["character", "npc"],
  },
  {
    path: "system.hp.value",
    type: "NumberField",
    required: false,
    nullable: false,
    hasDefault: true,
    defaultValue: 0,
  },
];

void describe("schema discovery shared validation", () => {
  void it("reports missing required and invalid enum fields with stable paths", () => {
    const result = validateDiscoveredFields({ type: "vehicle" }, fields, "create");
    assert.deepEqual(
      result.errors.map(({ code, path }) => ({ code, path })),
      [
        { code: "REQUIRED", path: "name" },
        { code: "INVALID_ENUM", path: "type" },
      ],
    );
  });

  void it("does not require omitted fields for update and warns on unknown nested fields", () => {
    const result = validateDiscoveredFields(
      { system: { hp: { value: 7, secret: true } }, mystery: 1 },
      fields,
      "update",
    );
    assert.equal(result.errors.length, 0);
    assert.deepEqual(
      result.warnings.map(({ path }) => path),
      ["system.hp.secret", "mystery"],
    );
  });

  void it("clones without changing input and produces key-order-independent evidence", () => {
    const input = { b: 2, a: { z: 1 } };
    const clone = cloneSchemaCandidate(input);
    clone.a = { z: 9 };
    assert.deepEqual(input, { b: 2, a: { z: 1 } });
    assert.equal(stableSchemaValue(input), stableSchemaValue({ a: { z: 1 }, b: 2 }));
  });
});
