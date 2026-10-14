import { readManagedCredential } from "./foundry-managed-credential.mjs";

// Invoke only as Codex http_headers_helper. stdout is a private credential pipe,
// never an operator terminal, log, report, or diagnostic capture.
try {
  if (process.stdout.isTTY || process.stdin.isTTY) throw new Error();
  const record = readManagedCredential();
  if (!record) throw new Error();
  process.stdout.write(JSON.stringify({ "x-api-key": record.key }));
} catch {
  process.stderr.write("Managed local credential unavailable.\n");
  process.exitCode = 1;
}
