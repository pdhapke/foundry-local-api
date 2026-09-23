export const SHARED_PACKAGE_NAME = "@foundry-local-api/shared";

export type {
  BridgeRequest,
  BridgeResponse,
  BridgeSuccessResponse,
  BridgeErrorResponse,
  BridgeError,
  CommandHandler,
  BridgeEventMessage,
} from "./protocol.js";

export { META_COMMANDS } from "./meta.js";
export type {
  StatusResult,
  WorldInfo,
  SystemInfo,
  UserInfo,
  ModuleInfo,
  SettingInfo,
} from "./meta.js";

export { SETTINGS_COMMANDS } from "./settings.js";
export type { GetSettingInput, SetSettingInput, SettingValue } from "./settings.js";

export { DOCUMENT_COMMANDS } from "./documents.js";
export type {
  DocumentTypeInput,
  DocumentIdInput,
  DocumentCreateInput,
  DocumentUpdateInput,
  DocumentData,
  DocumentDeleteResult,
} from "./documents.js";

export { BULK_COMMANDS } from "./bulk.js";
export type {
  DocumentQueryInput,
  DocumentBatchCreateInput,
  DocumentBatchUpdateEntry,
  DocumentBatchUpdateInput,
  DocumentBatchDeleteInput,
  DocumentBatchDeleteResult,
} from "./bulk.js";

export { ACTOR_COMMANDS } from "./actors.js";
export type { ActorIdInput, ActorRollData } from "./actors.js";

export { EMBEDDED_ITEM_COMMANDS } from "./items.js";
export type {
  EmbeddedItemIdInput,
  EmbeddedItemCreateInput,
  EmbeddedItemUpdateInput,
} from "./items.js";

export { SCENE_COMMANDS } from "./scenes.js";
export type { SceneIdInput, SceneDimensions } from "./scenes.js";

export { TOKEN_COMMANDS } from "./tokens.js";
export type {
  SceneTokenListInput,
  SceneTokenIdInput,
  SceneTokenCreateInput,
  SceneTokenUpdateInput,
  SceneTokenMoveInput,
  SceneTokenVisibilityInput,
} from "./tokens.js";

export { JOURNAL_PAGE_COMMANDS } from "./journal-pages.js";
export type {
  JournalPageListInput,
  JournalPageIdInput,
  JournalPageCreateInput,
  JournalPageUpdateInput,
} from "./journal-pages.js";

export { ROLL_COMMANDS } from "./rolls.js";
export type { RollEvaluateInput, RollDieResult, RollEvaluateResult } from "./rolls.js";

export { CHAT_COMMANDS } from "./chat.js";
export type { ChatListInput, ChatSendInput, ChatMessageData } from "./chat.js";

export { MACRO_COMMANDS } from "./macros.js";
export type { MacroIdInput, MacroExecuteResult } from "./macros.js";

export { COMBAT_COMMANDS } from "./combats.js";
export type {
  CombatIdInput,
  CombatAddCombatantInput,
  CombatRemoveCombatantInput,
  CombatRollInitiativeInput,
} from "./combats.js";

export { PLAYLIST_COMMANDS } from "./playlists.js";
export type { PlaylistSoundIdInput } from "./playlists.js";

export { ROLL_TABLE_COMMANDS } from "./roll-tables.js";
export type { RollTableDrawInput, RollTableDrawResult } from "./roll-tables.js";

export { CARDS_COMMANDS } from "./cards.js";
export type { CardsDrawInput, CardsIdInput } from "./cards.js";

export { FOLDER_COMMANDS } from "./folders.js";
export type { FolderMoveDocumentInput } from "./folders.js";

export { PACK_COMMANDS } from "./packs.js";
export type {
  PackInfo,
  PackIndexEntry,
  PackIdInput,
  PackEntryIdInput,
  PackCreateEntryInput,
  PackUpdateEntryInput,
} from "./packs.js";

export { EMBEDDED_EFFECT_COMMANDS } from "./active-effects.js";
export type {
  EffectParentType,
  EffectParentInput,
  EffectIdInput,
  EffectCreateInput,
  EffectUpdateInput,
} from "./active-effects.js";

export { EMBEDDED_PLACEABLE_COMMANDS, CANVAS_COMMANDS } from "./placeables.js";
export type {
  PlaceableDocumentType,
  PlaceableParentInput,
  PlaceableIdInput,
  PlaceableCreateInput,
  PlaceableUpdateInput,
  CanvasPanInput,
  CanvasPanResult,
} from "./placeables.js";

export { PERMISSION_COMMANDS } from "./permissions.js";
export type {
  DocumentOwnershipMap,
  DocumentOwnershipInput,
  DocumentSetOwnershipInput,
  DocumentOwnershipResult,
  UserRoleInput,
  UserRoleResult,
  UserSetRoleInput,
} from "./permissions.js";

export { FILE_COMMANDS } from "./files.js";
export type {
  FileBrowseInput,
  FileBrowseResult,
  FileUploadInput,
  FileUploadResult,
  CreateDirectoryInput,
  CreateDirectoryResult,
} from "./files.js";

export { USER_COMMANDS } from "./users.js";
export type {
  UserIdInput,
  UserCreateInput,
  UserUpdateInput,
  UserStatusResult,
  CanvasSelectionResult,
} from "./users.js";

export { LOCALIZATION_COMMANDS } from "./localization.js";
export type {
  LocalizeInput,
  LocalizeResult,
  EnrichHtmlInput,
  EnrichHtmlResult,
  SearchInput,
  SearchMatch,
  SearchResult,
} from "./localization.js";

export type { FoundryEventRecord, RecentEventsInput, RecentEventsResult } from "./events.js";

export { GAME_STATE_COMMANDS } from "./game-state.js";
export type { GamePausedResult, SetGamePausedInput } from "./game-state.js";

export { DND5E_COMMANDS } from "./dnd5e.js";
export type {
  Dnd5eActorIdInput,
  Dnd5eConfigResult,
  Dnd5eActorSheetResult,
  Dnd5eInventoryItem,
  Dnd5eAbilityRollInput,
  Dnd5eSkillRollInput,
  Dnd5eRestInput,
  Dnd5eSpellSlotInput,
  Dnd5eItemUseInput,
  Dnd5eRollActionResult,
  Dnd5eRestResult,
  Dnd5eSpellSlotResult,
  Dnd5eItemUseResult,
} from "./dnd5e.js";
