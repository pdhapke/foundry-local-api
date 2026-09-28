import { z } from "zod";
import {
  REFERENCE_AUDIT_COMMAND,
  type ReferenceAuditClass,
  type ReferenceAuditInput,
  type ReferenceAuditResult,
} from "@foundry-local-api/shared";
import type { AssetLifecycleService } from "../services/asset-lifecycle.js";
import type { AnyEndpointDescriptor } from "./types.js";
export function createReferenceAuditEndpointDescriptors(
  service?: AssetLifecycleService,
): AnyEndpointDescriptor[] {
  return [
    {
      name: "foundry_audit_campaign_references",
      description:
        "Read-only bounded campaign reference-integrity audit. Returns per-class completeness; clean is null whenever any class is incomplete.",
      method: "post",
      path: "/references/audit",
      inputSchema: z
        .object({
          includeDocumentTypes: z.array(z.string().min(1).max(64)).max(100).optional(),
          maxDocuments: z.number().int().min(1).max(10000).optional(),
          maxIssues: z.number().int().min(1).max(2000).optional(),
        })
        .strict(),
      handler: async (input: ReferenceAuditInput, { foundryClient }) => {
        const result = await foundryClient.call<ReferenceAuditInput, ReferenceAuditResult>(
          REFERENCE_AUDIT_COMMAND,
          input,
        );
        if (!service) return result;
        const requiredClasses: ReferenceAuditClass[] = [
          "uuid",
          "asset",
          "embedded",
          "note",
          "tokenActor",
          "folder",
          "ownership",
          "stableId",
          "tableResult",
        ];
        for (const kind of requiredClasses)
          if (!result.classes.some((entry) => entry.class === kind))
            result.classes.push({
              class: kind,
              complete: false,
              scanned: 0,
              issueCount: 0,
              reason: "The client omitted required reference coverage.",
            });
        const assetClass = result.classes.find((x) => x.class === "asset");
        // The required-class pass above guarantees this entry.
        if (!assetClass) throw new Error("unreachable asset coverage state");
        let complete = assetClass.scanned > 0 || result.scannedDocuments === 0;
        for (const issue of result.issues.filter((x) => x.class === "asset")) {
          if (!issue.target) continue;
          try {
            const found = await service.inspect({ root: "data", path: issue.target });
            issue.code = found.exists ? "ASSET_OK" : "MISSING_ASSET";
            issue.message = found.exists ? "Asset exists." : "Asset was not found.";
          } catch {
            complete = false;
          }
        }
        if (assetClass) {
          assetClass.complete = complete;
          if (complete) delete assetClass.reason;
          else assetClass.reason = "Some asset paths could not be validated.";
        }
        result.issues = result.issues.filter((x) => x.code !== "ASSET_OK");
        assetClass.issueCount = result.issues.filter((x) => x.class === "asset").length;
        result.complete = result.classes.every((x) => x.complete);
        result.clean = result.complete ? result.issues.length === 0 : null;
        return result;
      },
      annotations: { readOnlyHint: true },
    },
  ];
}
