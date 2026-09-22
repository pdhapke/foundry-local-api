// Phase 7 — Settings Read/Write command handlers. Registered against the
// same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// GM-only gating for world-scope settings lives here, not on the server:
// the server has no concept of "which Foundry user issued this request"
// beyond a single static API key (Phase 4), whereas the connected module
// always knows both the registered setting's `scope` and `game.user.isGM`.
import {
  SETTINGS_COMMANDS,
  type GetSettingInput,
  type SetSettingInput,
  type SettingValue,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requireRegisteredSetting(
  namespace: string,
  key: string,
): ClientSettings.RegisteredSetting {
  const cfg = game.settings.settings.get(`${namespace}.${key}`);
  if (!cfg) {
    throw new Error(`Unknown setting "${namespace}.${key}"`);
  }
  return cfg;
}

registerCommand(
  SETTINGS_COMMANDS.GET_SETTING,
  ({ namespace, key }: GetSettingInput): SettingValue => {
    requireRegisteredSetting(namespace, key);
    return { namespace, key, value: game.settings.get(namespace, key) };
  },
);

registerCommand(
  SETTINGS_COMMANDS.SET_SETTING,
  async ({ namespace, key, value }: SetSettingInput): Promise<SettingValue> => {
    const cfg = requireRegisteredSetting(namespace, key);
    if (cfg.scope === "world" && !game.user.isGM) {
      throw new Error(`Only a GM may change the world-scope setting "${namespace}.${key}".`);
    }
    const stored = await game.settings.set(namespace, key, value);
    return { namespace, key, value: stored };
  },
);
