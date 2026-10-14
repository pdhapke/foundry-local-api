import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
/** Captured once when this module is loaded; later disk edits are not runtime evidence. */
export const startupBuildIdentity = (() => {
  const artifacts = ["server/dist/index.js", "server/dist/app.js", "server/dist/latency-trace.js", "server/dist/endpoints/registry.js", "server/dist/endpoints/world-documents.js", "server/dist/mcp/http-tool-client.js", "server/dist/endpoints/attack-actions.js", "server/dist/endpoints/scene-render.js", "server/dist/endpoints/requirement-output-schemas.js", "server/dist/bridge/foundry-client.js", "server/dist/endpoints/routine-mutation-lane.js", "shared/dist/protocol.js", "shared/dist/world-documents.js", "shared/dist/attack-actions.js", "shared/dist/scene-render.js", "module/dist/index.js", "module/src/latency-build.ts"];
  const hashes: Record<string, string | null> = {};
  const root = new URL("../../", import.meta.url);
  for (const path of artifacts) try { hashes[path] = createHash("sha256").update(readFileSync(fileURLToPath(new URL(path, root)))).digest("hex"); } catch { hashes[path] = null; }
  return { startedAt: new Date().toISOString(), instrumentation: "latency-v1", artifactHashes: hashes, manifestDigest: createHash("sha256").update(JSON.stringify(hashes)).digest("hex"), scope: "Node startup artifact bytes; verify native loaded marker separately" };
})();
