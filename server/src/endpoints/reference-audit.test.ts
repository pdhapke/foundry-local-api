import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FoundryClient } from "../bridge/foundry-client.js";
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
        } as unknown as FoundryClient,
      },
    );
    assert.equal(value.clean, null);
  });

  void it("completes asset validation and permits a clean result only after every class completes", async () => {
    let inspectCalls = 0;
    const descriptor = createReferenceAuditEndpointDescriptors({
      exists: async () => {
        inspectCalls += 1;
        return true;
      },
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
    assert.equal(inspectCalls, 1);

    const coreAsset = await descriptor.handler(
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
                target: "icons/svg/d20-grey.svg",
                message: "Asset path requires server-side validation.",
              },
            ],
            truncated: false,
          }),
        } as any,
      },
    );
    assert.equal(coreAsset.complete, true);
    assert.equal(coreAsset.clean, true);
    assert.deepEqual(coreAsset.issues, []);
    assert.equal(inspectCalls, 2);

    const remoteAsset = await descriptor.handler(
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
                target: "blob:https://example.invalid/id/image.png",
                message: "Asset path requires server-side validation.",
              },
            ],
            truncated: false,
          }),
        } as any,
      },
    );
    assert.equal(remoteAsset.complete, false);
    assert.equal(remoteAsset.clean, null);
    assert.equal(remoteAsset.issues[0]?.code, "REMOTE_ASSET_UNVALIDATED");
    assert.equal(inspectCalls, 2);
  });

  void it("fails closed and redacts filesystem failures", async () => {
    const descriptor = createReferenceAuditEndpointDescriptors({
      exists: async () => {
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
    assert.equal(value.issues[0]?.code, "ASSET_VALIDATION_ERROR");
    assert.doesNotMatch(JSON.stringify(value), /private|campaign|secret\.png/);
  });
});
