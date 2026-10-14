import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readManagedCredential, managedDirectory } from "./foundry-managed-credential.mjs";

const defaultEnvironmentPath = fileURLToPath(new URL("../server/.env", import.meta.url));

/**
 * Resolve the Local API's own server credential for process-tree companions.
 * The credential is never logged or returned to a browser and remains owned by
 * this module even when handed to a sibling child through its environment.
 */
export function loadOrCreateCompanionApiKey({
  environmentPath = defaultEnvironmentPath,
  random = randomBytes,
  credentialDirectory = managedDirectory,
} = {}) {
  const managed = readManagedCredential(credentialDirectory);
  if (managed) return managed.key;
  const contents = existsSync(environmentPath) ? readFileSync(environmentPath, "utf8") : "";
  const match = /^API_KEY=(.*)$/m.exec(contents);
  const existing = match?.[1]?.trim() ?? "";
  if (existing) {
    if (existing.length < 16) throw new Error("Local API companion credential is too short.");
    return existing;
  }

  const generated = random(32).toString("hex");
  const next = match
    ? contents.replace(/^API_KEY=.*$/m, `API_KEY=${generated}`)
    : `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}API_KEY=${generated}\n`;
  writeFileSync(environmentPath, next, { encoding: "utf8", mode: 0o600 });
  return generated;
}
