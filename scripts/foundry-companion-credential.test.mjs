import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadOrCreateCompanionApiKey } from "./foundry-companion-credential.mjs";

test("reuses the Local API credential without rewriting or exposing it", () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-companion-key-"));
  const path = join(directory, ".env");
  writeFileSync(path, "PORT=3939\nAPI_KEY=existing-companion-secret\n", "utf8");
  assert.equal(loadOrCreateCompanionApiKey({ environmentPath: path }), "existing-companion-secret");
  assert.equal(readFileSync(path, "utf8"), "PORT=3939\nAPI_KEY=existing-companion-secret\n");
});

test("provisions one random credential while preserving unrelated settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-companion-key-"));
  const path = join(directory, ".env");
  writeFileSync(path, "PORT=3939\nAPI_KEY=\nHOST=127.0.0.1\n", "utf8");
  const key = loadOrCreateCompanionApiKey({
    environmentPath: path,
    random: () => Buffer.alloc(32, 7),
  });
  assert.equal(key, Buffer.alloc(32, 7).toString("hex"));
  const saved = readFileSync(path, "utf8");
  assert.match(saved, /^PORT=3939$/m);
  assert.match(saved, /^HOST=127\.0\.0\.1$/m);
  assert.equal(saved.match(/^API_KEY=/gm)?.length, 1);
});

test("rejects an explicitly weak existing credential", () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-companion-key-"));
  const path = join(directory, ".env");
  writeFileSync(path, "API_KEY=short\n", "utf8");
  assert.throws(() => loadOrCreateCompanionApiKey({ environmentPath: path }), /too short/);
});
