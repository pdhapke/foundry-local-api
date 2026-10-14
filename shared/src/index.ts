export const SHARED_PACKAGE_NAME = "@foundry-local-api/shared";

export type {
  BridgeRequest,
  BridgeResponse,
  BridgeSuccessResponse,
  BridgeErrorResponse,
  BridgeError,
  CommandHandler,
  CommandTiming,
  NativeLatency,
  BridgeEventMessage,
  BridgeEventDelivery,
  BridgeEventSenderIdentity,
  BridgeEventAcknowledgement,
} from "./protocol.js";

export { BRIDGE_PROTOCOL_VERSION, ProtocolError, assertIdempotencyKey } from "./foundations.js";
export type {
  BridgeClientLane,
  BridgeClientIdentity,
  BridgeVersionInfo,
  BridgeHelloMessage,
  ConnectedBridgeClient,
  ProtocolErrorCode,
  StructuredProtocolError,
  RevisionExpectation,
  IdempotencyOptions,
  CapabilityState,
  CapabilityReportEntry,
  CapabilityReport,
  MutationAuditRecord,
  RecordFixtureFileInput,
  TestFixtureDocumentRef,
  TestFixtureRun,
} from "./foundations.js";

export { TRACK0_COMMANDS, withTestRunFlag } from "./track0.js";
export type { TestRunIdInput, RecordFixtureDocumentInput } from "./track0.js";
export * from "./enrollment.js";

export {
  SCHEMA_DISCOVERY_COMMANDS,
  cloneSchemaCandidate,
  isPlainRecord,
  stableSchemaValue,
  validateDiscoveredFields,
} from "./schema-discovery.js";

export * from "./effective-user.js";
export * from "./transactions.js";
export * from "./collision-topology.js";
export * from "./dnd5e-simulation.js";
export * from "./movement-events.js";
export * from "./fog-exploration.js";
export * from "./scene-render.js";
export * from "./client-readiness.js";
export * from "./embedded-children.js";
export * from "./asset-lifecycle.js";
export * from "./reference-audit.js";
export type {
  DiscoveredSchemaField,
  SchemaDiscoveryResult,
  SchemaRuntimeContext,
  SchemaTargetInput,
  SchemaValidationInput,
  SchemaValidationBatchResult,
  SchemaValidationIssue,
  SchemaValidationMode,
  SchemaValidationResult,
} from "./schema-discovery.js";

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
export type {
  SceneIdInput,
  SceneDimensions,
  SceneGridAlignmentInput,
  SceneGridAlignmentResult,
  SceneGridState,
  SceneResetFogResult,
} from "./scenes.js";

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
  CombatUpdateCombatantInput,
  CombatRollInitiativeInput,
} from "./combats.js";

export { PLAYLIST_COMMANDS } from "./playlists.js";
export type { PlaylistSoundIdInput, PlaylistIdInput } from "./playlists.js";

export { ROLL_TABLE_COMMANDS } from "./roll-tables.js";
export type { RollTableDrawInput, RollTableDrawResult } from "./roll-tables.js";

export { CARDS_COMMANDS } from "./cards.js";
export type { CardsDrawInput, CardsIdInput, CardsPassInput, CardsDealInput } from "./cards.js";

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
  PackCreatePackInput,
  PackDuplicatePackInput,
} from "./packs.js";

export { ADVENTURE_COMMANDS } from "./adventures.js";
export type { AdventureExportInput, AdventureImportResult } from "./adventures.js";

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
  CanvasPushViewMessage,
} from "./placeables.js";

export { MODULE_SOCKET_EVENT } from "./socket.js";

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
  CanvasTargetsResult,
  SetCanvasTargetsInput,
  ActiveGmResult,
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
export type {
  GamePausedResult,
  SetGamePausedInput,
  ConfirmedPauseInput,
  ConfirmedPauseResult,
} from "./game-state.js";

export { WORLD_TIME_COMMANDS } from "./world-time.js";
export type { WorldTimeResult, AdvanceWorldTimeInput } from "./world-time.js";

export { NOTIFICATION_COMMANDS } from "./notifications.js";
export type {
  NotificationType,
  NotifyInput,
  NotifyResult,
  NotifyBroadcastMessage,
} from "./notifications.js";

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

export { DTT_COMMANDS } from "./digital-tabletops.js";
export type { DttPanInput, DttAckResult, DttStatusResult } from "./digital-tabletops.js";

export { TRAILS_COMMANDS } from "./trails-of-destiny.js";
export type {
  TrailsGetConfigInput,
  TrailsListCatalogsInput,
  TrailsJsonPrimitive,
  TrailsJsonValue,
  TrailsJsonObject,
  TrailsContractVersions,
  TrailsSourceCitation,
  TrailsIssueSeverity,
  TrailsIssue,
  TrailsUnmappedValue,
  TrailsRuleStatus,
  TrailsActorType,
  TrailsItemType,
  TrailsResourceId,
  TrailsConfigEntry,
  TrailsThreatClassification,
  TrailsCatalogDescriptor,
  TrailsCapabilities,
  TrailsConfigResult,
  TrailsActorIdInput,
  TrailsPreparedAbility,
  TrailsPreparedResource,
  TrailsReadinessCounts,
  TrailsReadinessSummary,
  TrailsActorSheetResult,
  TrailsItemOrigin,
  TrailsTalentInventoryItem,
  TrailsConnectionInventoryItem,
  TrailsCraftInventoryItem,
  TrailsEquipmentInventoryItem,
  TrailsQuartzInventoryItem,
  TrailsCoreInventoryItem,
  TrailsInventoryItem,
  TrailsActorInventoryResult,
  TrailsCatalogSummary,
  TrailsCatalogListResult,
  TrailsCatalogInput,
  TrailsCatalogEntry,
  TrailsCatalogResult,
  TrailsCreationLaneId,
  TrailsCreationLaneResult,
  TrailsCreationReadinessResult,
  TrailsConditionalDieInput,
  TrailsActionRollInput,
  TrailsActionDieResult,
  TrailsBonusDieResult,
  TrailsDieRankResult,
  TrailsActionRollResult,
  TrailsInitiativeParticipantInput,
  TrailsInitiativeInput,
  TrailsInitiativeParticipantResult,
  TrailsInitiativeGroup,
  TrailsInitiativeResult,
  TrailsThreatContestInput,
  TrailsThreatContestResult,
  TrailsLifeState,
  TrailsDamagePreviewInput,
  TrailsDamageState,
  TrailsDamagePreviewResult,
  TrailsRecoveryResourceInput,
  TrailsRecoveryResourceMap,
  TrailsRecoveryEligibility,
  TrailsRecoveryPreviewInput,
  TrailsRecoveryOperation,
  TrailsRecoveryClaim,
  TrailsRecoveryPreviewFailure,
  TrailsRecoveryPreviewSuccess,
  TrailsRecoveryPreviewResult,
  TrailsExperienceProgressInput,
  TrailsExperienceProgressFailure,
  TrailsExperienceProgressSuccess,
  TrailsExperienceProgressResult,
  TrailsBuilderPreviewInput,
  TrailsBuilderActorPreview,
  TrailsBuilderItemPreview,
  TrailsBuilderPreviewResult,
} from "./trails-of-destiny.js";
export * from "./session-actions.js";
export * from "./world-documents.js";
export * from "./attack-actions.js";
export * from "./native-gm.js";

export * from "./gm-combat.js";
export * from "./gm-activities.js";
export * from "./gm-character.js";
export * from "./gm-tv.js";
