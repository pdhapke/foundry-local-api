// Phase 21 — Active Effects command handlers. Registered against the same
// command dispatcher registry Phase 2 set up (module/src/command-registry.ts)
// and imported for side effects from module/src/index.ts.
//
// An ActiveEffect can be embedded on either an Actor or an Item (unlike
// Phase 10's Item, which is only ever embedded on an Actor), so every
// handler here resolves its parent generically off `game.collections`
// keyed by the request's `parentType` rather than assuming one fixed
// collection.
import {
  EMBEDDED_EFFECT_COMMANDS,
  type DocumentData,
  type DocumentDeleteResult,
  type EffectCreateInput,
  type EffectIdInput,
  type EffectParentInput,
  type EffectParentType,
  type EffectUpdateInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

type EffectParent = FoundryActor | FoundryItem;

function requireParent(parentType: EffectParentType, parentId: string): EffectParent {
  const collection = game.collections.get(parentType) as Map<string, EffectParent> | undefined;
  const parent = collection?.get(parentId);
  if (!parent) {
    throw new Error(`${parentType} "${parentId}" not found`);
  }
  return parent;
}

function requireEffect(parent: EffectParent, effectId: string): FoundryDocument {
  const effect = parent.effects.get(effectId);
  if (!effect) {
    throw new Error(`ActiveEffect "${effectId}" not found`);
  }
  return effect;
}

registerCommand(
  EMBEDDED_EFFECT_COMMANDS.LIST,
  ({ parentType, parentId }: EffectParentInput): DocumentData[] =>
    Array.from(requireParent(parentType, parentId).effects.values()).map((effect) =>
      effect.toObject(),
    ),
);

registerCommand(
  EMBEDDED_EFFECT_COMMANDS.GET,
  ({ parentType, parentId, effectId }: EffectIdInput): DocumentData =>
    requireEffect(requireParent(parentType, parentId), effectId).toObject(),
);

registerCommand(
  EMBEDDED_EFFECT_COMMANDS.CREATE,
  async ({ parentType, parentId, data }: EffectCreateInput): Promise<DocumentData> => {
    const [created] = await requireParent(parentType, parentId).createEmbeddedDocuments(
      "ActiveEffect",
      [data],
    );
    if (!created) {
      throw new Error("Failed to create active effect");
    }
    return created.toObject();
  },
);

registerCommand(
  EMBEDDED_EFFECT_COMMANDS.UPDATE,
  async ({ parentType, parentId, effectId, changes }: EffectUpdateInput): Promise<DocumentData> => {
    const effect = requireEffect(requireParent(parentType, parentId), effectId);
    await effect.update(changes);
    return effect.toObject();
  },
);

registerCommand(
  EMBEDDED_EFFECT_COMMANDS.DELETE,
  async ({ parentType, parentId, effectId }: EffectIdInput): Promise<DocumentDeleteResult> => {
    const effect = requireEffect(requireParent(parentType, parentId), effectId);
    await effect.delete();
    return { id: effectId };
  },
);
