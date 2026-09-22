// Phase 26 — Hooks/Event Streaming (module side).
//
// Deliberately NOT under module/src/commands/, unlike every other
// module-side handler file: everything in commands/ registers inbound
// BridgeRequest handlers via the command dispatcher
// (module/src/command-registry.ts) — it reacts to a request from the
// server. This file does the opposite: it originates outbound
// BridgeEventMessages, the first case (PLAN.md Phase 26) of the module
// pushing unsolicited data to the server rather than replying to one.
// Keeping it out of commands/ avoids implying it participates in
// dispatch(), which it never does.
//
// A small, curated list of Foundry hooks — matching PLAN.md's own examples
// (createActor, updateToken, chatMessage) plus the obvious per-document-type
// companions — not exhaustive coverage of every Foundry hook, consistent
// with this project's repeated narrow-scope precedent (see PLAN.md's Phase
// 16/17/19 deviation notes). `chatMessage` itself doesn't exist as a
// document-lifecycle hook in current Foundry versions; the real hook is
// `createChatMessage` (ChatMessage is a regular Document, same as every
// other type here), which is what's registered below.
import type { BridgeClient } from "./bridge-client.js";

const FORWARDED_HOOKS = [
  "createActor",
  "updateActor",
  "deleteActor",
  "createItem",
  "updateItem",
  "deleteItem",
  "createToken",
  "updateToken",
  "deleteToken",
  "createChatMessage",
] as const;

/**
 * Duck-types a Foundry Document instance (has a `toObject()` method) among a
 * hook's raw callback args. Exported (Phase 31) so this pure predicate can
 * be unit-tested directly, without a real `Hooks` global — see
 * hooks.test.ts.
 */
export function hasToObject(value: unknown): value is { toObject: () => unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toObject?: unknown }).toObject === "function"
  );
}

/**
 * Normalizes one hook callback argument for the wire. Foundry hook callbacks
 * receive raw Document instances (not plain data) as their first arg(s) —
 * this returns `.toObject()` for anything that looks like one, matching the
 * convention every module/src/commands/*.ts handler already follows (return
 * `.toObject()`, never a raw instance); every other arg (options objects,
 * user ids, etc.) passes through unchanged. Exported (Phase 31) for the same
 * direct-unit-testability reason as {@link hasToObject} above.
 */
export function normalizeHookArg(value: unknown): unknown {
  return hasToObject(value) ? value.toObject() : value;
}

/**
 * Registers `Hooks.on(...)` for {@link FORWARDED_HOOKS}, forwarding each
 * firing to the server via `client.sendEvent()`. Takes the live
 * `BridgeClient` instance as a parameter (inversion of control) rather than
 * reaching into module/src/index.ts for a shared reference — called from
 * index.ts's `ready` hook right after `client` is constructed and connected,
 * keeping index.ts's diff to just that one function body.
 */
export function registerHookForwarding(client: BridgeClient): void {
  for (const hookName of FORWARDED_HOOKS) {
    Hooks.on(hookName, (...args: unknown[]) => {
      client.sendEvent(hookName, args.map(normalizeHookArg));
    });
  }
}
