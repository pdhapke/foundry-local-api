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
