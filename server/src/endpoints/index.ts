// Full list of endpoint descriptors, REST+MCP shared infrastructure (moved
// out of mcp/ in Phase 6 — see registry.ts). Every later phase appends its
// own descriptor array here.
import { fileURLToPath } from "node:url";
import { createAssetLifecycleEndpointDescriptors } from "./asset-lifecycle.js";
import { aiGmDeliveryEndpointDescriptors } from "./ai-gm-delivery.js";
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
import { movementEventEndpointDescriptors } from "./movement-events.js";
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

const transactionEndpointDescriptors = createTransactionEndpointDescriptors(
  productionTransactionJournal,
);
const assetLifecycleService = new AssetLifecycleService({
  roots: { data: fileURLToPath(new URL("../../../../../", import.meta.url)) },
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
const assetLifecycleEndpointDescriptors =
  createAssetLifecycleEndpointDescriptors(assetLifecycleService);
const referenceAuditEndpointDescriptors =
  createReferenceAuditEndpointDescriptors(assetLifecycleService);

export const allEndpointDescriptors: AnyEndpointDescriptor[] = [
  healthEndpointDescriptor,
  ...aiGmDeliveryEndpointDescriptors,
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
  ...worldTimeEndpointDescriptors,
  ...notificationEndpointDescriptors,
];

export { makeDocumentEndpoints } from "./documents.js";
export type { DocumentEndpointConfig } from "./documents.js";
export type { AnyEndpointDescriptor, EndpointContext, EndpointDescriptor } from "./types.js";
