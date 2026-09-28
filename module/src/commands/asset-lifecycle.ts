import {
  ASSET_COMMANDS,
  ProtocolError,
  type AssetReference,
  type AssetReferenceInput,
  type AssetReferenceResult,
} from "@foundry-local-api/shared";
import { registerCommand } from "../command-registry.js";

function walk(value: unknown, path: string, visit: (path: string, value: string) => void): void {
  if (typeof value === "string") {
    visit(path, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}.${index}`, visit));
    return;
  }
  if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
      walk(child, path ? `${path}.${key}` : key, visit);
}

function referencedPaths(value: string): string[] {
  const candidates = [value];
  for (const pattern of [
    /(?:src|href)\s*=\s*["']([^"']+)["']/gi,
    /url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi,
  ])
    for (const match of value.matchAll(pattern)) if (match[1]) candidates.push(match[1]);
  return candidates;
}

function normalize(path: string): string {
  try {
    return decodeURIComponent(path).replaceAll("\\", "/").replace(/^\/+/, "");
  } catch {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "Asset path encoding is invalid.",
      retryable: false,
      fieldPath: "path",
    });
  }
}

export function findAssetReferences(input: AssetReferenceInput): AssetReferenceResult {
  const target = normalize(input.path);
  const references: AssetReference[] = [];
  const warnings: string[] = [];
  let complete = true;
  try {
    for (const collection of game.collections.values()) {
      for (const document of collection.values()) {
        const uuid = (document as FoundryDocument & { uuid: string }).uuid;
        try {
          walk(document.toObject(), "", (fieldPath, value) => {
            if (
              referencedPaths(value).some((candidate) => {
                try {
                  return normalize(candidate) === target;
                } catch {
                  complete = false;
                  return false;
                }
              })
            )
              references.push({ documentUuid: uuid, fieldPath });
          });
        } catch {
          complete = false;
          warnings.push("A world document could not be scanned for asset references.");
        }
      }
    }
  } catch {
    complete = false;
    warnings.push("A world collection could not be scanned for asset references.");
  }
  if (references.length > 500) {
    complete = false;
    warnings.push("Reference results were bounded at 500 entries.");
  }
  return {
    path: target,
    references: references.slice(0, 500),
    complete,
    warnings: [...new Set(warnings)],
  };
}

registerCommand(ASSET_COMMANDS.REFERENCES, async (input: AssetReferenceInput) =>
  findAssetReferences(input),
);
