// Phase 42 — UI Notifications. One endpoint wrapping `ui.notifications.notify()`,
// Foundry's client-local toast/banner mechanism (see shared/src/
// notifications.ts for why `target: "all"` reuses Phase 47's module-scoped
// `game.socket` broadcast plumbing instead of inventing a second one).
import { z } from "zod";

import {
  NOTIFICATION_COMMANDS,
  type NotifyInput,
  type NotifyResult,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const notifySchema = z.object({
  message: z.string().min(1),
  type: z.enum(["info", "warning", "error"]).optional(),
  target: z.enum(["caller", "all"]).optional(),
});

const notifyDescriptor: EndpointDescriptor<NotifyInput, NotifyResult> = {
  name: "foundry_notify",
  description:
    'Shows a UI notification (toast/banner) on the connected client. `target: "all"` (default ' +
    '"caller") also broadcasts it to every other connected client, GM and players alike, unlike ' +
    "ui.notifications.notify()'s normal client-local-only behavior.",
  method: "post",
  path: "/notify",
  inputSchema: notifySchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<NotifyInput, NotifyResult>(NOTIFICATION_COMMANDS.NOTIFY, input),
};

export const notificationEndpointDescriptors: AnyEndpointDescriptor[] = [notifyDescriptor];
