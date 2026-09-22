export const SHARED_PACKAGE_NAME = "@foundry-local-api/shared";

export type {
  BridgeRequest,
  BridgeResponse,
  BridgeSuccessResponse,
  BridgeErrorResponse,
  BridgeError,
  CommandHandler,
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
