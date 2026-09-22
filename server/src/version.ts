// Reads the server package's own version for the /health endpoint.
//
// Deliberately reads package.json from disk at runtime (rather than a JSON
// module import) so this works identically from `src/` (ts-node-less dev)
// and from `dist/` after `tsc` build without relying on import-attribute
// syntax (`with { type: "json" }`), whose required form has shifted across
// recent Node versions.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | undefined;

export function readPackageVersion(): string {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // This file lives at either server/src/version.ts or server/dist/version.js,
    // both one directory below the package root.
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    cachedVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}
