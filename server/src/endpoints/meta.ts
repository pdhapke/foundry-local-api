// Phase 6 — Core Meta/Introspection Endpoints (first full vertical slice).
//
// Seven read-only descriptors, each a thin wrapper around a single bridge
// call to the module's command registry (module/src/commands/meta.ts). All
// are param-free GETs mounted under `/api` (see server/src/routes/api.ts).
import {
  META_COMMANDS,
  type ModuleInfo,
  type SettingInfo,
  type StatusResult,
  type SystemInfo,
  type UserInfo,
  type WorldInfo,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const statusDescriptor: EndpointDescriptor<void, StatusResult> = {
  name: "foundry_get_status",
  description:
    "Core Foundry world/system/user identifiers: Foundry version, world id, system id, and current user id.",
  method: "get",
  path: "/status",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, StatusResult>(META_COMMANDS.STATUS),
};

const worldDescriptor: EndpointDescriptor<void, WorldInfo> = {
  name: "foundry_get_world",
  description:
    "Details of the currently active Foundry world (id, title, description, system, background).",
  method: "get",
  path: "/world",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, WorldInfo>(META_COMMANDS.WORLD),
};

const systemDescriptor: EndpointDescriptor<void, SystemInfo> = {
  name: "foundry_get_system",
  description: "Details of the active game system (id, title, version).",
  method: "get",
  path: "/system",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, SystemInfo>(META_COMMANDS.SYSTEM),
};

const userDescriptor: EndpointDescriptor<void, UserInfo> = {
  name: "foundry_get_user",
  description:
    "Details of the current Foundry user connected via the bridge (id, name, role, isGM, active).",
  method: "get",
  path: "/user",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, UserInfo>(META_COMMANDS.USER),
};

const usersDescriptor: EndpointDescriptor<void, UserInfo[]> = {
  name: "foundry_list_users",
  description: "Every user in the world (id, name, role, isGM, active).",
  method: "get",
  path: "/users",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, UserInfo[]>(META_COMMANDS.USERS),
};

const modulesDescriptor: EndpointDescriptor<void, ModuleInfo[]> = {
  name: "foundry_list_modules",
  description: "Every installed module (id, title, active, version), including inactive ones.",
  method: "get",
  path: "/modules",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, ModuleInfo[]>(META_COMMANDS.MODULES),
};

const settingsDescriptor: EndpointDescriptor<void, SettingInfo[]> = {
  name: "foundry_list_settings",
  description:
    "Every registered game setting (namespace, key, name, hint, scope, config, typeName).",
  method: "get",
  path: "/settings",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, SettingInfo[]>(META_COMMANDS.SETTINGS),
};

export const metaEndpointDescriptors: AnyEndpointDescriptor[] = [
  statusDescriptor,
  worldDescriptor,
  systemDescriptor,
  userDescriptor,
  usersDescriptor,
  modulesDescriptor,
  settingsDescriptor,
];
