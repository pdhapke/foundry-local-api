// Phase 21 — Active Effects. Command names and payload/result shapes for
// embedded ActiveEffect CRUD, shared between the server's active-effect
// endpoint factory (server/src/endpoints/active-effects.ts) and the module's
// embedded-effect command handlers (module/src/commands/active-effects.ts).
//
// Unlike Phase 10's embedded Items (which only ever hang off an Actor), an
// ActiveEffect can be embedded on either an Actor or an Item, so every
// payload here carries `parentType` alongside `parentId` rather than a
// fixed `actorId` field. `parentType` isn't wire-configurable on any one
// REST route, though — the server's factory (one call per parent type)
// bakes it in via closure, the same way Phase 8's `documentType` is baked
// into each `makeDocumentEndpoints()` call.

export const EMBEDDED_EFFECT_COMMANDS = {
  LIST: "effectList",
  GET: "effectGet",
  CREATE: "effectCreate",
  UPDATE: "effectUpdate",
  DELETE: "effectDelete",
} as const;

/** The two Foundry document types an ActiveEffect can be embedded on. */
export type EffectParentType = "Actor" | "Item";

export interface EffectParentInput {
  parentType: EffectParentType;
  parentId: string;
}

export interface EffectIdInput extends EffectParentInput {
  effectId: string;
}

export interface EffectCreateInput extends EffectParentInput {
  data: Record<string, unknown>;
}

export interface EffectUpdateInput extends EffectIdInput {
  changes: Record<string, unknown>;
}
