import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadOrCreateCompanionApiKey } from "./foundry-companion-credential.mjs";

const serverDirectory = fileURLToPath(new URL("../server/", import.meta.url));
const serverEntryPoint = fileURLToPath(new URL("../server/dist/index.js", import.meta.url));
export const foundryLocalApiCompanionCredential = loadOrCreateCompanionApiKey();

if (!existsSync(serverEntryPoint)) {
  console.error(
    `[foundry-local-api] Built server entry point is missing: ${serverEntryPoint}. Run npm run build in the module directory.`,
  );
} else {
  const child = spawn(process.execPath, [serverEntryPoint], {
    cwd: serverDirectory,
    env: { ...process.env, API_KEY: foundryLocalApiCompanionCredential },
    stdio: "inherit",
    windowsHide: false,
  });

  // Do not let the API child keep Foundry alive after Foundry has otherwise
  // finished shutting down. The synchronous exit hook below still terminates
  // the child during a normal exit or handled signal.
  child.unref();

  child.once("spawn", () => {
    console.log(`[foundry-local-api] Started child process ${child.pid}.`);
  });

  child.once("error", (error) => {
    console.error(`[foundry-local-api] Failed to start child process: ${error.message}`);
  });

  child.once("exit", (code, signal) => {
    if (process.exitCode === undefined) {
      console.error(
        `[foundry-local-api] Child process exited while Foundry is still running (code=${code ?? "none"}, signal=${signal ?? "none"}).`,
      );
    }
  });

  process.once("exit", () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  });
}
