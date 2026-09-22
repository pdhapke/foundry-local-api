// Phase 6 — Core Meta/Introspection command handlers. Registered against the
// same command dispatcher registry Phase 2 set up (module/src/command-registry.ts)
// and imported for side effects from module/src/index.ts. Each handler reads
// straight off long-stable, extensively-documented core Foundry globals
// (game.world/system/user/users/modules/settings), not any system-specific
// API — see PLAN.md's Phase 6 notes on why no live-instance inspection was
// needed to implement this against the documented shapes.
import {
  META_COMMANDS,
  type ModuleInfo,
  type SettingInfo,
  type StatusResult,
  type SystemInfo,
  type UserInfo,
  type WorldInfo,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function toUserInfo(user: FoundryUser): UserInfo {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    isGM: user.isGM,
    active: user.active,
  };
}

registerCommand(META_COMMANDS.STATUS, (): StatusResult => ({
  foundryVersion: game.release.version,
  worldId: game.world.id,
  systemId: game.system.id,
  userId: game.user.id,
}));

registerCommand(META_COMMANDS.WORLD, (): WorldInfo => ({
  id: game.world.id,
  title: game.world.title,
  description: game.world.description ?? null,
  system: game.world.system,
  background: game.world.background ?? null,
}));

registerCommand(META_COMMANDS.SYSTEM, (): SystemInfo => ({
  id: game.system.id,
  title: game.system.title,
  version: game.system.version,
}));

registerCommand(META_COMMANDS.USER, (): UserInfo => toUserInfo(game.user));

registerCommand(META_COMMANDS.USERS, (): UserInfo[] =>
  Array.from(game.users.values()).map(toUserInfo),
);

registerCommand(META_COMMANDS.MODULES, (): ModuleInfo[] =>
  Array.from(game.modules.values()).map((mod) => ({
    id: mod.id,
    title: mod.title,
    active: mod.active,
    version: mod.version,
  })),
);

registerCommand(META_COMMANDS.SETTINGS, (): SettingInfo[] =>
  Array.from(game.settings.settings.entries()).map(([fullKey, cfg]) => {
    // Setting keys themselves never contain dots, so splitting on the
    // *first* dot correctly separates "<namespace>.<key>" even if the
    // namespace does (e.g. a scoped module id).
    const dotIndex = fullKey.indexOf(".");
    const namespace = dotIndex === -1 ? fullKey : fullKey.slice(0, dotIndex);
    const key = dotIndex === -1 ? "" : fullKey.slice(dotIndex + 1);

    return {
      namespace,
      key,
      name: cfg.name ?? null,
      hint: cfg.hint ?? null,
      scope: cfg.scope,
      config: cfg.config,
      typeName: typeof cfg.type === "function" ? (cfg.type as { name: string }).name : String(cfg.type),
    };
  }),
);
