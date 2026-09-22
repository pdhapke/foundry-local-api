// Phase 33 — Manifest Declaration Convention.
//
// PLAN.md's Phase 33 text asks for a check that "fails if an integration
// registered in the Phase 32 code registry has no matching manifest entry,
// or vice versa, so the two never drift as more integrations are added."
// This script is that check.
//
// Two sources of truth are compared:
//   - server/src/integrations/registry.ts's `integrations` array — the code
//     side. Being registered here IS the "implemented" signal; there's no
//     separate flag on `Integration` for it.
//   - module.json's `flags["foundry-local-api"].optionalIntegrations` array
//     — the manifest side (see PLAN.md's "Manifest note" above Phase 32:
//     `relationships.recommends` is Foundry-facing/human-readable only and
//     deliberately NOT parsed here; this loader-facing custom block is the
//     actual source of truth our code reads). Each entry carries an
//     `implemented?: boolean` flag (default `true` when omitted) so a
//     "declared but not yet built" integration (dnd5e, right now) can be
//     declared ahead of its code landing without tripping this check —
//     PLAN.md's own Phase 33 wording doesn't spell out how to represent that
//     state, so this flag is this phase's answer to that gap (see PLAN.md's
//     deviation log).
//
// This is build/CI tooling, not server runtime code — same convention as
// generate-docs.ts: lives under src/scripts/, never ships in dist/, run ad
// hoc via `npm run check-manifest-sync` (see server/package.json), and wired
// into CI (.github/workflows/ci.yml) as its own step.
//
// Unlike generate-docs.ts, this file needs no `import "../app.js"` circular-
// import workaround: `../integrations/registry.js` only imports
// `./types.js`, and `./types.js` only imports `../endpoints/types.js` as a
// `import type` (erased at compile time, so it produces no runtime import at
// all) — it never transitively reaches `../endpoints/index.js`/`../app.js`/
// `../routes/api.js`, the cycle generate-docs.ts has to work around.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { integrations } from "../integrations/registry.js";

// This file lives at server/src/scripts/check-manifest-sync.ts; the repo
// root (where module.json lives) is three directories up — same depth/
// reasoning as generate-docs.ts's REPO_ROOT.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULE_JSON_PATH = join(REPO_ROOT, "module.json");

/** One `flags["foundry-local-api"].optionalIntegrations[]` entry, as read from module.json. */
interface ManifestIntegrationEntry {
  id: string;
  kind: string;
  /** Defaults to `true` when omitted — see this file's header comment. */
  implemented?: boolean;
}

/** The subset of `Integration` (server/src/integrations/types.ts) this comparison actually needs. */
interface CodeIntegrationEntry {
  id: string;
  kind: string;
}

/**
 * Pure comparison logic, independently testable with no file I/O — mirrors
 * this codebase's established pattern of extracting pure logic out of a thin
 * CLI/glue shell for testability (e.g. `bridge-client.ts`'s
 * `computeBackoffDelayMs`/`buildBridgeConnectionUrl`, Phase 32's
 * `IntegrationManager` being unit-tested against a fake `FoundryClient`).
 *
 * Returns a list of human-readable problem strings; an empty array means the
 * two sides are in sync.
 */
export function diffIntegrationManifestSync(
  codeIntegrations: CodeIntegrationEntry[],
  manifestEntries: ManifestIntegrationEntry[],
): string[] {
  const problems: string[] = [];

  // Duplicate ids within either list are always a problem, independent of
  // cross-referencing the other list.
  problems.push(...findDuplicateIds(codeIntegrations, "code registry (registry.ts)"));
  problems.push(
    ...findDuplicateIds(manifestEntries, "manifest (module.json optionalIntegrations)"),
  );

  const manifestById = new Map(manifestEntries.map((entry) => [entry.id, entry]));
  const codeById = new Map(codeIntegrations.map((entry) => [entry.id, entry]));

  for (const code of codeIntegrations) {
    const manifestEntry = manifestById.get(code.id);
    if (!manifestEntry) {
      problems.push(
        `"${code.id}" is registered in the code integration registry but has no matching ` +
          `module.json optionalIntegrations entry.`,
      );
      continue;
    }
    // Being registered in code IS the "implemented" signal — a manifest
    // entry that still claims `implemented: false` for a now-real
    // integration is a contradiction that should have been flipped to
    // `true` (or had the key removed) when the code landed.
    if (manifestEntry.implemented === false) {
      problems.push(
        `"${code.id}" is registered in the code integration registry, but its module.json ` +
          `optionalIntegrations entry still has "implemented": false.`,
      );
    }
    if (manifestEntry.kind !== code.kind) {
      problems.push(
        `"${code.id}" has mismatched "kind" between the code registry ("${code.kind}") and ` +
          `module.json optionalIntegrations ("${manifestEntry.kind}").`,
      );
    }
  }

  for (const manifestEntry of manifestEntries) {
    // `implemented` defaults to `true` when omitted (see this function's
    // doc comment). `implemented: false` with no code registration is the
    // legitimate "planned, not yet built" state (dnd5e, right now) — not an
    // error.
    const implemented = manifestEntry.implemented ?? true;
    if (implemented && !codeById.has(manifestEntry.id)) {
      problems.push(
        `"${manifestEntry.id}" is declared in module.json optionalIntegrations as implemented ` +
          `(no "implemented": false), but has no matching entry in the code integration registry.`,
      );
    }
  }

  return problems;
}

function findDuplicateIds(entries: { id: string }[], sourceLabel: string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      duplicates.add(entry.id);
    }
    seen.add(entry.id);
  }
  return Array.from(duplicates, (id) => `Duplicate id "${id}" found in ${sourceLabel}.`);
}

/** Narrow an unknown JSON value down to the manifest entries array, defensively — module.json is hand-edited. */
function readManifestIntegrationEntries(): ManifestIntegrationEntry[] {
  const raw = readFileSync(MODULE_JSON_PATH, "utf8");
  const manifest = JSON.parse(raw) as {
    flags?: { "foundry-local-api"?: { optionalIntegrations?: unknown } };
  };
  const entries = manifest.flags?.["foundry-local-api"]?.optionalIntegrations;
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.map((entry) => {
    const e = entry as Record<string, unknown>;
    const result: ManifestIntegrationEntry = {
      id: String(e["id"]),
      kind: String(e["kind"]),
    };
    if (typeof e["implemented"] === "boolean") {
      result.implemented = e["implemented"];
    }
    return result;
  });
}

function main(): void {
  const manifestEntries = readManifestIntegrationEntries();
  const codeIntegrations: CodeIntegrationEntry[] = integrations.map((integration) => ({
    id: integration.id,
    kind: integration.kind,
  }));

  const problems = diffIntegrationManifestSync(codeIntegrations, manifestEntries);

  if (problems.length === 0) {
    console.log(
      `✓ Integration manifest in sync (${codeIntegrations.length} code, ${manifestEntries.length} manifest entries).`,
    );
    process.exit(0);
  }

  console.error("Integration manifest / code registry mismatch:");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

// Guarded, unlike generate-docs.ts's unconditional `main()`: that script has
// no test file importing from it, but this one does
// (check-manifest-sync.test.ts imports `diffIntegrationManifestSync` from
// this same module), and an unconditional `main()` would run this script's
// real file-reading/process.exit() side effects as an import side effect of
// that test file, killing the test run after whichever single test happened
// to execute before `process.exit()` fired. Only run `main()` when this file
// is the actual CLI entry point (`node ... check-manifest-sync.ts`), not when
// it's merely imported.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
