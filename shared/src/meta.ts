// Phase 6 — core meta/introspection command names and result shapes, shared
// between the server's endpoint descriptors (server/src/endpoints/meta.ts)
// and the module's command handlers (module/src/commands/meta.ts) so the two
// sides can't drift apart via stringly-typed command names.

export const META_COMMANDS = {
  STATUS: "status",
  WORLD: "world",
  SYSTEM: "system",
  USER: "user",
  USERS: "users",
  MODULES: "modules",
  SETTINGS: "settings",
} as const;

export interface StatusResult {
  foundryVersion: string;
  worldId: string;
  systemId: string;
  userId: string;
}

export interface WorldInfo {
  id: string;
  title: string;
  description: string | null;
  system: string;
  background: string | null;
}

export interface SystemInfo {
  id: string;
  title: string;
  version: string;
}

export interface UserInfo {
  id: string;
  name: string;
  role: number;
  isGM: boolean;
  active: boolean;
}

export interface ModuleInfo {
  id: string;
  title: string;
  active: boolean;
  version: string;
}

export interface SettingInfo {
  namespace: string;
  key: string;
  name: string | null;
  hint: string | null;
  scope: "client" | "world";
  config: boolean;
  typeName: string;
}
