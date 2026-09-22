// Phase 7 — Settings Read/Write command names and payload/result shapes,
// shared between the server's endpoint descriptors
// (server/src/endpoints/settings.ts) and the module's command handlers
// (module/src/commands/settings.ts).

export const SETTINGS_COMMANDS = {
  GET_SETTING: "getSetting",
  SET_SETTING: "setSetting",
} as const;

export interface GetSettingInput {
  namespace: string;
  key: string;
}

export interface SetSettingInput extends GetSettingInput {
  value: unknown;
}

/** Result shape for both a read and a write — a write echoes the value Foundry ended up storing. */
export interface SettingValue {
  namespace: string;
  key: string;
  value: unknown;
}
