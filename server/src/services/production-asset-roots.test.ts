import assert from "node:assert/strict";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { AssetLifecycleService } from "./asset-lifecycle.js";
import { resolveProductionAssetRoots } from "./production-asset-roots.js";

void describe("production asset roots", () => {
  void it("registers Foundry App/public only for internal reference auditing", async () => {
    const roots = resolveProductionAssetRoots();
    const expectedCore = path.resolve(roots.lifecycle.data, "..", "..", "App", "public");

    assert.deepEqual(Object.keys(roots.lifecycle), ["data"]);
    assert.deepEqual(Object.keys(roots.referenceAudit).sort(), ["core", "data"]);
    assert.equal(await realpath(roots.referenceAudit.core), await realpath(expectedCore));
    assert.equal((await stat(roots.referenceAudit.core)).isDirectory(), true);
  });

  void it("fails closed when a configured root does not exist", async () => {
    const service = new AssetLifecycleService({
      roots: { core: path.join(path.parse(process.cwd()).root, "missing-foundry-core-root") },
    });

    await assert.rejects(
      service.exists({ root: "core", path: "icons/svg/d20-grey.svg" }),
      (error: unknown) =>
        (error as { code?: string; message?: string }).code === "PROTECTED_PATH" &&
        (error as { message?: string }).message === "Configured asset root does not exist.",
    );
  });
});
