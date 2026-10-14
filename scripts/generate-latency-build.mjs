import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const root = new URL("../", import.meta.url);
const inputs = ["module/src/bridge-client.ts", "module/src/command-registry.ts", "module/src/commands/session-actions.ts", "shared/src/protocol.ts", "module/src/commands/scene-render.ts", "shared/src/scene-render.ts", "module/src/commands/schema-discovery.ts", "shared/src/schema-discovery.ts"];
const hash = createHash("sha256");
for (const path of inputs) hash.update(path).update(readFileSync(new URL(path, root)));
writeFileSync(new URL("module/src/latency-build.ts", root), `// Generated at build time from instrumentation inputs; no runtime disk inference.\nexport const LATENCY_BUILD = ${JSON.stringify(hash.digest("hex"))};\n`);
