import { replaceManagedCredential } from "./foundry-managed-credential.mjs";
// Internal worker of approved Apply-Foundry-Managed-Credential.ps1 only.
if (!process.argv.includes("--stopped-runtime-checked")) {
  process.stderr.write("Use the repository credential operation wrapper.\n");
  process.exitCode = 1;
} else {
  try {
    const result = replaceManagedCredential({ initialize: process.argv.includes("--initialize"), recover: process.argv.includes("--recover") });
    console.log(`Managed local credential committed (generation ${result.generation}).`);
  } catch {
    process.stderr.write("Credential operation refused or failed. No secrets emitted; inspect managed state through the supported recovery procedure.\n");
    process.exitCode = 1;
  }
}
