import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const source = readFileSync(
  resolve(import.meta.dirname, "../../../../../systems/dnd5e/dnd5e.mjs"),
  "utf8",
);
function installedMethod(signature: string) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0);
  const end = source.indexOf("\n    }", start);
  assert.ok(end > start);
  return source.slice(start, end + "\n    }".length);
}
function harness(postConsumptionCancel = false) {
  const events: string[] = [];
  let spent = 0;
  const Hooks = {
    call: (name: string) => !(postConsumptionCancel && name === "dnd5e.postActivityConsumption"),
  };
  const foundry = {
    utils: {
      mergeObject: (a: any, b: any) => ({ ...a, ...b }),
      isEmpty: (a: any) => Object.keys(a).length === 0,
      setProperty: (a: any, p: string, v: any) => {
        const keys = p.split(".");
        for (const k of keys.slice(0, -1)) a = a[k] ??= {};
        a[keys.at(-1)!] = v;
      },
    },
  };
  const TargetsField = { getDescriptors: () => [] };
  const ui = {
    notifications: {
      error: () => {
        throw Error("unexpected native notification");
      },
    },
  };
  const make = (signature: string) =>
    new Function(
      "Hooks",
      "foundry",
      "TargetsField",
      "ui",
      `return {${installedMethod(signature).replaceAll("#applyUsageUpdates", "_applyUsageUpdates")}}`,
    )(Hooks, foundry, TargetsField, ui);
  const activity: any = {
    id: "act",
    metadata: { usage: {} },
    canUse: true,
    _prepareUsageConfig: (u: any) => ({ ...u, hasConsumption: true }),
    _prepareUsageScaling: async () => {},
    _prepareUsageUpdates: async () => ({
      activity: { uses: { spent: spent + 1 } },
      actor: {},
      item: [],
    }),
    _applyUsageUpdates: async () => {
      spent++;
      events.push("consumed");
      return { activity: 1 };
    },
    _finalizeMessageConfig: () => {},
    _createUsageMessage: async () => {
      events.push("message");
      return null;
    },
    _finalizeUsage: async () => {},
    _triggerSubsequentActions: () => events.push("automatic-roll"),
  };
  const item: any = {
    isEmbedded: true,
    isOwner: true,
    system: { activities: new Map([["act", activity]]) },
    clone: () => item,
    updateSource: () => {},
  };
  activity.item = item;
  activity.actor = {};
  activity.consume = make("async consume(usageConfig, messageConfig) {").consume;
  activity.use = make("async use(usage={}, dialog={}, message={}) {").use;
  return { activity, events, spent: () => spent };
}
// Node's test runner owns completion of these registered tests.
void test("installed dnd5e use consumes before message and explicit no subsequent action suppresses auto-roll", async () => {
  const h = harness();
  const result = await h.activity.use(
    { subsequentActions: false },
    { configure: false },
    { create: false },
  );
  assert.ok(result.updates);
  assert.equal(h.spent(), 1);
  assert.deepEqual(h.events, ["consumed", "message"]);
});
void test("installed dnd5e post-consumption cancellation returns undefined after resource mutation", async () => {
  const h = harness(true);
  const result = await h.activity.use(
    { subsequentActions: false },
    { configure: false },
    { create: false },
  );
  assert.equal(result, undefined);
  assert.equal(h.spent(), 1);
  assert.deepEqual(h.events, ["consumed"]);
});
