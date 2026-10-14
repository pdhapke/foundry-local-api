// Full list of endpoint descriptors, REST+MCP shared infrastructure (moved
// out of mcp/ in Phase 6 — see registry.ts). Every later phase appends its
// own descriptor array here.
import { createAssetLifecycleEndpointDescriptors } from "./asset-lifecycle.js";
import { createAcceptanceValidationEndpointDescriptors } from "./acceptance-validation.js";
import { activeEffectEndpointDescriptors } from "./active-effects.js";
import { actorEndpointDescriptors } from "./actors.js";
import { adventureEndpointDescriptors } from "./adventures.js";
import { bulkEndpointDescriptors } from "./bulk.js";
import { bridgeEnrollmentEndpointDescriptors } from "./bridge-enrollment.js";
import { clientReadinessEndpointDescriptors } from "./client-readiness.js";
import { collisionTopologyEndpointDescriptors } from "./collision-topology.js";
import { cardsEndpointDescriptors } from "./cards.js";
import { chatEndpointDescriptors } from "./chat.js";
import { combatEndpointDescriptors } from "./combats.js";
import { journalEntryEndpointDescriptors } from "./documents.js";
import { eventEndpointDescriptors } from "./events.js";
import { effectiveUserEndpointDescriptors } from "./effective-user.js";
import { embeddedChildrenEndpointDescriptors } from "./embedded-children.js";
import { folderEndpointDescriptors } from "./folders.js";
import { foundationEndpointDescriptors } from "./foundations.js";
import { gameStateEndpointDescriptors } from "./game-state.js";
import { healthEndpointDescriptor } from "./health.js";
import { itemEndpointDescriptors } from "./items.js";
import { fileEndpointDescriptors } from "./files.js";
import { journalPageEndpointDescriptors } from "./journal-pages.js";
import { localizationEndpointDescriptors } from "./localization.js";
import { macroEndpointDescriptors } from "./macros.js";
import { metaEndpointDescriptors } from "./meta.js";
import { notificationEndpointDescriptors } from "./notifications.js";
import { packEndpointDescriptors } from "./packs.js";
import { permissionEndpointDescriptors } from "./permissions.js";
import { placeableEndpointDescriptors } from "./placeables.js";
import { playlistEndpointDescriptors } from "./playlists.js";
import { rollEndpointDescriptors } from "./rolls.js";
import { rollTableEndpointDescriptors } from "./roll-tables.js";
import { dnd5eSimulationEndpointDescriptors } from "./dnd5e-simulation.js";
import { fogExplorationEndpointDescriptors } from "./fog-exploration.js";
import {
  getMovementEventStoreDiagnostics,
  movementEventEndpointDescriptors,
} from "./movement-events.js";
import { sceneEndpointDescriptors } from "./scenes.js";
import { schemaDiscoveryEndpointDescriptors } from "./schema-discovery.js";
import { sceneRenderEndpointDescriptors } from "./scene-render.js";
import { settingsEndpointDescriptors } from "./settings.js";
import { tokenEndpointDescriptors } from "./tokens.js";
import { createTransactionEndpointDescriptors } from "./transactions.js";
import { createReferenceAuditEndpointDescriptors } from "./reference-audit.js";
import type { AnyEndpointDescriptor } from "./types.js";
import { userEndpointDescriptors } from "./users.js";
import { worldTimeEndpointDescriptors } from "./world-time.js";
import { productionFixtureRegistry, productionTransactionJournal } from "../foundations/runtime.js";
import { AssetLifecycleService } from "../services/asset-lifecycle.js";
import { resolveProductionAssetRoots } from "../services/production-asset-roots.js";

const transactionEndpointDescriptors = createTransactionEndpointDescriptors(
  productionTransactionJournal,
);
const productionAssetRoots = resolveProductionAssetRoots();
const assetLifecycleService = new AssetLifecycleService({
  roots: productionAssetRoots.lifecycle,
  protectedPrefixes: {
    data: [
      "modules",
      "systems",
      "worlds/izzy-campaign/data",
      "worlds/izzy-campaign/packs",
      "worlds/izzy-campaign/world.json",
    ],
  },
  campaignOwnedPrefixes: { data: ["worlds/izzy-campaign/assets"] },
  fixtureOwnedPrefixes: { data: ["worlds/izzy-campaign/assets/mcp-test"] },
  isFixtureTestRunId: (testRunId) => productionFixtureRegistry.has(testRunId),
});
const referenceAuditAssetService = new AssetLifecycleService({
  roots: productionAssetRoots.referenceAudit,
});
const assetLifecycleEndpointDescriptors =
  createAssetLifecycleEndpointDescriptors(assetLifecycleService);
const referenceAuditEndpointDescriptors = createReferenceAuditEndpointDescriptors(
  referenceAuditAssetService,
);
const acceptanceValidationEndpointDescriptors = createAcceptanceValidationEndpointDescriptors({
  readiness: clientReadinessEndpointDescriptors.find(
    ({ name }) => name === "foundry_get_client_readiness",
  )!,
  fog: fogExplorationEndpointDescriptors.find(({ name }) => name === "foundry_get_scene_fog")!,
  visibility: sceneRenderEndpointDescriptors.find(
    ({ name }) => name === "foundry_get_token_visibility",
  )!,
  references: referenceAuditEndpointDescriptors.find(
    ({ name }) => name === "foundry_audit_campaign_references",
  )!,
  topology: collisionTopologyEndpointDescriptors.find(
    ({ name }) => name === "foundry_validate_wall_topology",
  )!,
  collision: collisionTopologyEndpointDescriptors.find(
    ({ name }) => name === "foundry_validate_token_path",
  )!,
  movementDiagnostics: getMovementEventStoreDiagnostics,
});

export const allEndpointDescriptors: AnyEndpointDescriptor[] = [
  healthEndpointDescriptor,
  ...acceptanceValidationEndpointDescriptors,
  ...bridgeEnrollmentEndpointDescriptors,
  ...foundationEndpointDescriptors,
  ...schemaDiscoveryEndpointDescriptors,
  ...effectiveUserEndpointDescriptors,
  ...transactionEndpointDescriptors,
  ...fogExplorationEndpointDescriptors,
  ...sceneRenderEndpointDescriptors,
  ...clientReadinessEndpointDescriptors,
  ...embeddedChildrenEndpointDescriptors,
  ...collisionTopologyEndpointDescriptors,
  ...dnd5eSimulationEndpointDescriptors,
  ...movementEventEndpointDescriptors,
  ...assetLifecycleEndpointDescriptors,
  ...referenceAuditEndpointDescriptors,
  ...metaEndpointDescriptors,
  ...settingsEndpointDescriptors,
  ...journalEntryEndpointDescriptors,
  ...journalPageEndpointDescriptors,
  ...actorEndpointDescriptors,
  ...itemEndpointDescriptors,
  ...sceneEndpointDescriptors,
  ...tokenEndpointDescriptors,
  ...rollEndpointDescriptors,
  ...chatEndpointDescriptors,
  ...macroEndpointDescriptors,
  ...combatEndpointDescriptors,
  ...playlistEndpointDescriptors,
  ...rollTableEndpointDescriptors,
  ...cardsEndpointDescriptors,
  ...folderEndpointDescriptors,
  ...packEndpointDescriptors,
  ...adventureEndpointDescriptors,
  ...activeEffectEndpointDescriptors,
  ...placeableEndpointDescriptors,
  ...permissionEndpointDescriptors,
  ...fileEndpointDescriptors,
  ...userEndpointDescriptors,
  ...localizationEndpointDescriptors,
  ...eventEndpointDescriptors,
  ...bulkEndpointDescriptors,
  ...gameStateEndpointDescriptors,
  ...sessionActionEndpointDescriptors,
  ...attackEndpointDescriptors,
  ...worldDocumentEndpointDescriptors,
  ...worldTimeEndpointDescriptors,
  ...notificationEndpointDescriptors,
];

export { makeDocumentEndpoints } from "./documents.js";
export type { DocumentEndpointConfig } from "./documents.js";
export type { AnyEndpointDescriptor, EndpointContext, EndpointDescriptor } from "./types.js";
import { sessionActionEndpointDescriptors } from "./session-actions.js";
import { attackEndpointDescriptors } from "./attack-actions.js";
import { worldDocumentEndpointDescriptors } from "./world-documents.js";
import { gmCombatEndpointDescriptors } from "./gm-combat.js";
import { gmActivitiesEndpointDescriptors } from "./gm-activities.js";
import { gmCharacterEndpointDescriptors } from "./gm-character.js";
import { gmTvEndpointDescriptors } from "./gm-tv.js";
import { createGmRecipeEndpointDescriptors } from "./gm-recipes.js";
allEndpointDescriptors.push(
  ...gmCombatEndpointDescriptors,
  ...gmActivitiesEndpointDescriptors,
  ...gmCharacterEndpointDescriptors,
  ...gmTvEndpointDescriptors,
);
allEndpointDescriptors.push(...gmReceiptEndpointDescriptors, ...gmSceneEndpointDescriptors);
allEndpointDescriptors.push(...createGmRecipeEndpointDescriptors(allEndpointDescriptors));

import { gmReceiptEndpointDescriptors } from "./gm-receipts.js";

import { gmSceneEndpointDescriptors } from "./gm-scene.js";
