import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { dispatch } from "../command-registry.js";
import { CANVAS_COMMANDS } from "@foundry-local-api/shared";
import "./placeables.js";

const original = Object.getOwnPropertyDescriptor(globalThis, "canvas");
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "canvas", original);
  else Reflect.deleteProperty(globalThis, "canvas");
});

test("GM camera placement returns its actual view without waiting for animation", async () => {
  const view = { x: 0, y: 0, scale: 1 };
  let pans = 0;
  Object.defineProperty(globalThis, "canvas", { configurable: true, value: {
    stage: { pivot: view, scale: { get x() { return view.scale; } } },
    pan(next: typeof view) { Object.assign(view, next); pans++; },
    animatePan() { throw new Error("Renderer animation must not gate remote camera placement"); },
  } });
  const requested = { x: 425, y: 675, scale: 1 };
  const result = await dispatch({ id: "camera-placement", type: CANVAS_COMMANDS.PAN, payload: requested });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, requested);
  assert.equal(pans, 1);
});