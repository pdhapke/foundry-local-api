// Phase 32 — small hand-rolled dotted-numeric version comparator, in the
// same "avoid a dependency when a small comparator suffices" spirit as
// Phase 30's zod v4 `z.toJSONSchema()` deviation. No semver range syntax
// (^, ~, prerelease tags, etc.) is supported or needed here — Foundry
// system/module `version` fields (shared/src/meta.ts's `SystemInfo`/
// `ModuleInfo`) and `Integration.minVersion`/`maxVersion` (./types.ts) are
// always plain dotted-numeric strings like "3.10.0".

/** Splits a dotted-numeric version string into its numeric segments, treating any missing/non-numeric segment as 0. */
function parseVersion(version: string): number[] {
  return version.split(".").map((segment) => {
    const n = Number.parseInt(segment, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

/** -1 if `a` < `b`, 1 if `a` > `b`, 0 if equal, comparing segment-by-segment and treating a missing trailing segment as 0. */
function compareVersions(a: string, b: string): number {
  const partsA = parseVersion(a);
  const partsB = parseVersion(b);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const segA = partsA[i] ?? 0;
    const segB = partsB[i] ?? 0;
    if (segA !== segB) {
      return segA < segB ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Whether `version` falls within the inclusive `[minVersion, maxVersion]`
 * range. Either bound may be omitted (no lower/upper bound); if both are
 * omitted, every version passes.
 */
export function isVersionInRange(
  version: string,
  minVersion?: string,
  maxVersion?: string,
): boolean {
  if (minVersion !== undefined && compareVersions(version, minVersion) < 0) {
    return false;
  }
  if (maxVersion !== undefined && compareVersions(version, maxVersion) > 0) {
    return false;
  }
  return true;
}
