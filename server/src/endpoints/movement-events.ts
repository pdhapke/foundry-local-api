import { z } from "zod";
import {
  ProtocolError,
  type MovementCursorQuery,
  type MovementEventInput,
  type MovementEventPage,
} from "@foundry-local-api/shared";
import type {
  MovementEventStore,
  MovementStoreDiagnostics,
} from "../events/movement-event-store.js";
import {
  movementEventOutputSchema,
  movementPageOutputSchema,
} from "./requirement-output-schemas.js";
import type { AnyEndpointDescriptor } from "./types.js";
let store: MovementEventStore | undefined;
let diagnostics: (() => MovementStoreDiagnostics) | undefined;
export function configureMovementEventStore(value: MovementEventStore | undefined) {
  store = value;
}
export function configureMovementEventStoreDiagnostics(
  value: (() => MovementStoreDiagnostics) | undefined,
) {
  diagnostics = value;
}
export function getMovementEventStoreDiagnostics(): MovementStoreDiagnostics {
  return (
    diagnostics?.() ?? {
      configured: false,
      runtimeAvailable: false,
      readable: false,
      valid: false,
      version: null,
      generation: null,
      eventCount: null,
      nextSequence: null,
      issueCodes: ["STORE_NOT_CONFIGURED"],
    }
  );
}
function requireStore() {
  if (!store)
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "Durable movement event store is not configured.",
      retryable: true,
    });
  return store;
}
const point = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    elevation: z.number().finite().optional(),
  })
  .strict();
const ingest = z
  .object({
    eventId: z.string().min(8).max(128),
    sceneId: z.string().min(1),
    tokenId: z.string().min(1),
    userId: z.string().min(1),
    timestamp: z.number().int().nonnegative().optional(),
    eventType: z.literal("token_movement").optional(),
    movementFields: z
      .array(z.enum(["x", "y", "elevation"]))
      .min(1)
      .max(3)
      .optional(),
    footprint: z
      .object({
        width: z.number().finite().nonnegative(),
        height: z.number().finite().nonnegative(),
      })
      .strict()
      .optional(),
    waypoints: z.array(point).min(2).max(256),
    regions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().optional(),
            polygons: z.array(z.array(point).min(3).max(512)).max(64),
            category: z
              .enum(["hazard", "threshold", "exit", "room", "corridor", "other"])
              .optional(),
            bottom: z.number().finite().optional(),
            top: z.number().finite().optional(),
            stopOnEnter: z.boolean().optional(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
const query = z
  .object({
    cursor: z.string().max(256).optional(),
    sceneId: z.string().optional(),
    tokenId: z.string().optional(),
    userId: z.string().optional(),
    eventType: z.literal("token_movement").optional(),
    movementField: z.enum(["x", "y", "elevation"]).optional(),
    transitionKind: z.enum(["enter", "exit"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();
export const movementEventEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_record_movement_event",
    description:
      "Legacy manual movement ingestion endpoint. Canonical movement provenance can only enter through an authenticated GM bridge event, so public ingestion is refused.",
    method: "post",
    path: "/movement-events",
    inputSchema: ingest,
    outputSchema: movementEventOutputSchema,
    handler: async (_input: MovementEventInput) => {
      throw new ProtocolError({
        code: "PERMISSION_DENIED",
        message:
          "Manual movement ingestion is disabled; durable events require authenticated bridge provenance.",
        retryable: false,
      });
    },
  },
  {
    name: "foundry_get_movement_events",
    description:
      "Reads durable sequenced movement events with cursor replay and Scene/Token/User/transition filters. Restart or expired cursors return an explicit CURSOR_GAP object.",
    method: "get",
    path: "/movement-events",
    inputSchema: query,
    outputSchema: movementPageOutputSchema,
    handler: (input: MovementCursorQuery): MovementEventPage => requireStore().query(input),
    annotations: { readOnlyHint: true },
  },
];
