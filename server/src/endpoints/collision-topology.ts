import { z } from "zod";
import {
  COLLISION_COMMANDS,
  type ValidateTokenPathInput,
  type ValidateTokenPathResult,
  type ValidateWallTopologyInput,
  type WallTopologyResult,
} from "@foundry-local-api/shared";
import {
  collisionPathOutputSchema,
  wallTopologyOutputSchema,
} from "./requirement-output-schemas.js";
import type { AnyEndpointDescriptor } from "./types.js";
const point = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    elevation: z.number().finite().optional(),
  })
  .strict();
export const collisionTopologyEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_validate_token_path",
    description:
      "Read-only token path collision validation against exact wall IDs, simulated door states, grid distance, elevation, and ordered waypoints. Campaign burrowing ignores walls but requires every segment to remain below elevation zero or be proven inside explicitly authoritative bounded Region surface geometry. Never moves the token or changes doors, Regions, or fog.",
    method: "post",
    path: "/scenes/collision/path",
    inputSchema: z
      .object({
        sceneId: z.string().min(1),
        tokenId: z.string().min(1),
        waypoints: z.array(point).min(1).max(256),
        movementMode: z.enum(["walk", "fly", "burrow"]),
        simulatedDoors: z
          .record(z.string(), z.enum(["open", "closed", "locked", "barred", "sealed"]))
          .optional(),
      })
      .strict(),
    outputSchema: collisionPathOutputSchema,
    handler: (input: ValidateTokenPathInput, { foundryClient }) =>
      foundryClient.call<ValidateTokenPathInput, ValidateTokenPathResult>(
        COLLISION_COMMANDS.VALIDATE_PATH,
        input,
      ),
    annotations: { readOnlyHint: true },
  },
  {
    name: "foundry_validate_wall_topology",
    description:
      "Read-only Scene wall topology audit for malformed, zero-length, duplicate, dangling, and crossing walls.",
    method: "get",
    path: "/scenes/wall-topology",
    inputSchema: z.object({ sceneId: z.string().min(1) }).strict(),
    outputSchema: wallTopologyOutputSchema,
    handler: (input: ValidateWallTopologyInput, { foundryClient }) =>
      foundryClient.call<ValidateWallTopologyInput, WallTopologyResult>(
        COLLISION_COMMANDS.VALIDATE_TOPOLOGY,
        input,
      ),
    annotations: { readOnlyHint: true },
  },
];
