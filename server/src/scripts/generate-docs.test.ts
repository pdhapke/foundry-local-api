import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOpenApiDocument } from "./generate-docs.js";

type JsonObject = Record<string, unknown>;

function objectAt(value: unknown, key: string): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const nested = (value as JsonObject)[key];
  assert.ok(nested && typeof nested === "object" && !Array.isArray(nested));
  return nested as JsonObject;
}

void describe("generated OpenAPI acceptance validation schema", () => {
  void it("publishes the concrete strict HTTP 200 response without changing the descriptor schema", () => {
    const document = buildOpenApiDocument();
    const paths = objectAt(document, "paths");
    const route = objectAt(paths, "/api/acceptance/validate-failures");
    const operation = objectAt(route, "post");
    const responses = objectAt(operation, "responses");
    const success = objectAt(responses, "200");
    const content = objectAt(success, "content");
    const json = objectAt(content, "application/json");
    const schema = objectAt(json, "schema");
    const properties = objectAt(schema, "properties");

    assert.equal(schema["type"], "object");
    assert.equal(schema["additionalProperties"], false);
    assert.deepEqual(schema["required"], [
      "generatedAt",
      "readOnly",
      "correlationId",
      "sceneId",
      "playerUserId",
      "playerTokenId",
      "playerClientId",
      "overall",
      "summary",
      "checks",
    ]);
    assert.equal(objectAt(properties, "readOnly")["const"], true);
    assert.deepEqual(objectAt(properties, "overall")["enum"], [
      "pass",
      "partial",
      "fail",
      "blocked",
    ]);

    const summary = objectAt(properties, "summary");
    assert.equal(summary["additionalProperties"], false);
    assert.deepEqual(summary["required"], ["pass", "partial", "fail", "blocked"]);

    const checks = objectAt(properties, "checks");
    assert.equal(checks["minItems"], 8);
    assert.equal(checks["maxItems"], 8);
    const checkAlternatives = objectAt(checks, "items")["oneOf"];
    assert.ok(Array.isArray(checkAlternatives));
    assert.equal(checkAlternatives.length, 8);
  });
});
