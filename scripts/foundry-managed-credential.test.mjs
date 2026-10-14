import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readManagedCredential, replaceManagedCredential } from "./foundry-managed-credential.mjs";
import { loadOrCreateCompanionApiKey } from "./foundry-companion-credential.mjs";

const fixture = () => {
  const root = mkdtempSync(join(process.cwd(), ".runtime/foundry-managed-test-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "credential");
};
test("explicit initialization and rotation synchronize consumers and reject stale values", () => {
  const directory = fixture();
  assert.equal(readManagedCredential(directory), null);
  assert.throws(() => replaceManagedCredential({ directory }));
  replaceManagedCredential({ directory, initialize: true });
  const old = readManagedCredential(directory).key;
  const environmentPath = join(directory, "legacy.env");
  writeFileSync(environmentPath, "API_KEY=synthetic-stale-legacy-value\n");
  assert.equal(loadOrCreateCompanionApiKey({ credentialDirectory: directory, environmentPath }), old);
  replaceManagedCredential({ directory });
  const next = readManagedCredential(directory);
  assert.equal(next.generation, 2);
  assert.notEqual(next.key, old);
  assert.equal(loadOrCreateCompanionApiKey({ credentialDirectory: directory, environmentPath }), next.key);
  assert.throws(() => replaceManagedCredential({ directory, initialize: true }));
});
test("concurrent operation refuses an existing lock without removing it", () => {
  const directory = fixture();
  mkdirSync(join(directory, "..", ".managed-credential.lock"));
  assert.throws(() => replaceManagedCredential({ directory, initialize: true }), /lock/);
});
test("partial initialization and corrupt records fail closed instead of legacy recovery", () => {
  const directory = fixture();
  mkdirSync(directory);
  assert.throws(() => readManagedCredential(directory), /unavailable/);
  assert.throws(() => replaceManagedCredential({ directory, initialize: true }));
  writeFileSync(join(directory, "current.json"), "{}");
  assert.throws(() => readManagedCredential(directory));
});
test("failed rotation preserves committed generation", () => {
  const directory = fixture();
  replaceManagedCredential({ directory, initialize: true });
  const before = readManagedCredential(directory);
  assert.throws(() => replaceManagedCredential({ directory, random: () => { throw new Error("synthetic failure"); } }));
  assert.deepEqual(readManagedCredential(directory), before);
});
test("directory loss fails closed and explicit recovery generates fresh state", () => {
  const directory = fixture();
  replaceManagedCredential({ directory, initialize: true });
  const old = readManagedCredential(directory).key;
  rmSync(directory, { recursive: true });
  assert.throws(() => readManagedCredential(directory));
  assert.throws(() => loadOrCreateCompanionApiKey({ credentialDirectory: directory }));
  replaceManagedCredential({ directory, recover: true });
  assert.notEqual(readManagedCredential(directory).key, old);
});
test("failure diagnostics never emit untrusted exception messages or codes", () => {
  const directory = fixture();
  const secret = "synthetic-secret-not-for-diagnostics";
  assert.throws(() => replaceManagedCredential({ directory, initialize: true, random: () => { const error = new Error(secret); error.code = secret; throw error; } }), error => !error.message.includes(secret));
});
