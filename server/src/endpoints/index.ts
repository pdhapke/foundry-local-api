// Full list of endpoint descriptors, REST+MCP shared infrastructure (moved
// out of mcp/ in Phase 6 — see registry.ts). Every later phase appends its
// own descriptor array here.
import { activeEffectEndpointDescriptors } from "./active-effects.js";
import { actorEndpointDescriptors } from "./actors.js";
import { bulkEndpointDescriptors } from "./bulk.js";
import { cardsEndpointDescriptors } from "./cards.js";
import { chatEndpointDescriptors } from "./chat.js";
import { combatEndpointDescriptors } from "./combats.js";
import { journalEntryEndpointDescriptors } from "./documents.js";
import { eventEndpointDescriptors } from "./events.js";
import { folderEndpointDescriptors } from "./folders.js";
import { gameStateEndpointDescriptors } from "./game-state.js";
import { healthEndpointDescriptor } from "./health.js";
import { itemEndpointDescriptors } from "./items.js";
import { fileEndpointDescriptors } from "./files.js";
import { journalPageEndpointDescriptors } from "./journal-pages.js";
import { localizationEndpointDescriptors } from "./localization.js";
import { macroEndpointDescriptors } from "./macros.js";
import { metaEndpointDescriptors } from "./meta.js";
import { packEndpointDescriptors } from "./packs.js";
import { permissionEndpointDescriptors } from "./permissions.js";
import { placeableEndpointDescriptors } from "./placeables.js";
import { playlistEndpointDescriptors } from "./playlists.js";
import { rollEndpointDescriptors } from "./rolls.js";
import { rollTableEndpointDescriptors } from "./roll-tables.js";
import { sceneEndpointDescriptors } from "./scenes.js";
import { settingsEndpointDescriptors } from "./settings.js";
import { tokenEndpointDescriptors } from "./tokens.js";
import type { AnyEndpointDescriptor } from "./types.js";
import { userEndpointDescriptors } from "./users.js";

export const allEndpointDescriptors: AnyEndpointDescriptor[] = [
  healthEndpointDescriptor,
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
  ...activeEffectEndpointDescriptors,
  ...placeableEndpointDescriptors,
  ...permissionEndpointDescriptors,
  ...fileEndpointDescriptors,
  ...userEndpointDescriptors,
  ...localizationEndpointDescriptors,
  ...eventEndpointDescriptors,
  ...bulkEndpointDescriptors,
  ...gameStateEndpointDescriptors,
];

export { makeDocumentEndpoints } from "./documents.js";
export type { DocumentEndpointConfig } from "./documents.js";
export type { AnyEndpointDescriptor, EndpointContext, EndpointDescriptor } from "./types.js";
