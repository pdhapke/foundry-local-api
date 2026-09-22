// Phase 7 — Settings Read/Write.
//
// Both descriptors share one route shape (`/settings/:namespace/:key`) and
// one flat inputSchema — `:namespace`/`:key` are merged in from the route
// params by validateQuery/validateBody (see middleware/validate.ts), so the
// same schema also works unmodified as the MCP tool's argument bag. GM-only
// gating for world-scope settings is enforced module-side (see
// module/src/commands/settings.ts), since only the connected module knows
// the registered setting's scope and the current Foundry user's role.
import { z } from "zod";

import {
  SETTINGS_COMMANDS,
  type GetSettingInput,
  type SetSettingInput,
  type SettingValue,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const namespaceAndKeySchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
});

const getSettingSchema = namespaceAndKeySchema;

const setSettingSchema = namespaceAndKeySchema.extend({
  value: z.unknown(),
});

const getSettingDescriptor: EndpointDescriptor<GetSettingInput, SettingValue> = {
  name: "foundry_get_setting",
  description: "Reads a single registered game setting by namespace and key.",
  method: "get",
  path: "/settings/:namespace/:key",
  inputSchema: getSettingSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<GetSettingInput, SettingValue>(SETTINGS_COMMANDS.GET_SETTING, input),
};

const setSettingDescriptor: EndpointDescriptor<SetSettingInput, SettingValue> = {
  name: "foundry_set_setting",
  description:
    "Writes a single registered game setting by namespace and key. World-scope settings require the connected Foundry user to be a GM.",
  method: "put",
  path: "/settings/:namespace/:key",
  inputSchema: setSettingSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<SetSettingInput, SettingValue>(SETTINGS_COMMANDS.SET_SETTING, input),
};

export const settingsEndpointDescriptors: AnyEndpointDescriptor[] = [
  getSettingDescriptor,
  setSettingDescriptor,
];
