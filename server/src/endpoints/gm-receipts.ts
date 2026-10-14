import { z } from "zod";
import type { AnyEndpointDescriptor } from "./types.js";
import { dispatchNativeGm } from "./native-gm-dispatch.js";
const id = z.string().min(1).max(128);
export const gmReceiptEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_gm_receipt_read",
    method: "post",
    path: "/gm/receipts/read",
    description:
      "Read one exact native durable reservation/receipt after cancellation, restart or reconnect. Read only, never rerolls or spends. Reserved and uncertain results require human reconciliation.",
    inputSchema: z
      .object({
        schemaVersion: z.literal("gm-actions-v1"),
        worldId: id,
        userId: id,
        sceneId: id,
        action: z.object({ kind: z.literal("receipt"), idempotencyKey: id }).strict(),
      })
      .strict(),
    annotations: { readOnlyHint: true },
    handler: (input, { foundryClient }) =>
      dispatchNativeGm(foundryClient, "gmReceiptRead", input, false),
  },
];
