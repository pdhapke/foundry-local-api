import { fileURLToPath } from "node:url";

export interface ProductionAssetRoots {
  lifecycle: Readonly<{ data: string }>;
  referenceAudit: Readonly<{ data: string; core: string }>;
}

/**
 * Keep the public asset-lifecycle surface restricted to Data while allowing
 * the internal reference audit to validate Foundry's application assets.
 */
export function resolveProductionAssetRoots(baseUrl = import.meta.url): ProductionAssetRoots {
  const data = fileURLToPath(new URL("../../../../../", baseUrl));
  const core = fileURLToPath(new URL("../../../../../../../App/public/", baseUrl));
  return {
    lifecycle: Object.freeze({ data }),
    referenceAudit: Object.freeze({ data, core }),
  };
}
