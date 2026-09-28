import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createReferenceAuditEndpointDescriptors } from "./reference-audit.js";
void describe("reference audit descriptor", () => {
  void it("keeps clean null without server filesystem validation", async () => {
    const descriptor = createReferenceAuditEndpointDescriptors()[0]!;
    const value = await descriptor.handler(
      {},
      {
        foundryClient: {
          call: async () => ({
            clean: null,
            complete: false,
            scannedDocuments: 0,
            classes: [],
            issues: [],
            truncated: false,
          }),
        } as any,
      },
    );
    assert.equal(value.clean, null);
  });
});
