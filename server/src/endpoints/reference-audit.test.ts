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

  void it("completes asset validation and permits a clean result only after every class completes", async () => {
    const descriptor = createReferenceAuditEndpointDescriptors({
      inspect: async () => ({ root: "data", path: "maps/ok.png", exists: true }),
    } as any)[0]!;
    const value = await descriptor.handler(
      {},
      {
        foundryClient: {
          call: async () => ({
            clean: null,
            complete: false,
            scannedDocuments: 1,
            classes: [
              "uuid",
              "asset",
              "embedded",
              "note",
              "tokenActor",
              "folder",
              "ownership",
              "stableId",
              "tableResult",
            ].map((kind) => ({
              class: kind,
              complete: kind !== "asset",
              scanned: 1,
              issueCount: kind === "asset" ? 1 : 0,
            })),
            issues: [
              {
                class: "asset",
                code: "ASSET_REQUIRES_SERVER_CHECK",
                documentUuid: "Scene.1",
                fieldPath: "background.src",
                target: "maps/ok.png",
                message: "Asset path requires server-side validation.",
              },
            ],
            truncated: false,
          }),
        } as any,
      },
    );
    assert.equal(value.complete, true);
    assert.equal(value.clean, true);
    assert.deepEqual(value.issues, []);
    assert.equal(
      value.classes.find((entry: { class: string }) => entry.class === "asset")?.issueCount,
      0,
    );
  });

  void it("fails closed and redacts filesystem failures", async () => {
    const descriptor = createReferenceAuditEndpointDescriptors({
      inspect: async () => {
        throw new Error("C:\\private\\campaign\\secret.png");
      },
    } as any)[0]!;
    const value = await descriptor.handler(
      {},
      {
        foundryClient: {
          call: async () => ({
            clean: true,
            complete: true,
            scannedDocuments: 1,
            classes: [{ class: "asset", complete: false, scanned: 1, issueCount: 1 }],
            issues: [
              {
                class: "asset",
                code: "ASSET_REQUIRES_SERVER_CHECK",
                documentUuid: "Scene.1",
                fieldPath: "background.src",
                target: "maps/a.png",
                message: "Asset path requires server-side validation.",
              },
            ],
            truncated: false,
          }),
        } as any,
      },
    );
    assert.equal(value.complete, false);
    assert.equal(value.clean, null);
    assert.doesNotMatch(JSON.stringify(value), /private|campaign|secret\.png/);
  });
});
