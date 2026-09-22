// Phase 21 — Active Effects.
//
// An ActiveEffect is embedded on either an Actor or an Item, so unlike
// Phase 10's Item-on-Actor-only descriptors, this file defines one factory
// (`makeEmbeddedEffectEndpoints()`, mirroring Phase 8's
// `makeDocumentEndpoints()`) and calls it twice — once per parent type —
// rather than hand-rolling each descriptor per parent. `parentType` is baked
// into each call's descriptors via closure; only `parentId`/`effectId`
// travel as REST path params. See module/src/commands/active-effects.ts for
// the matching module-side handlers.
import { z } from "zod";

import {
  EMBEDDED_EFFECT_COMMANDS,
  type DocumentData,
  type DocumentDeleteResult,
  type EffectCreateInput,
  type EffectIdInput,
  type EffectParentInput,
  type EffectParentType,
  type EffectUpdateInput,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

export interface EmbeddedEffectEndpointConfig {
  /** The Foundry document type this ActiveEffect is embedded on. */
  parentType: EffectParentType;
  /** REST path segment for the parent collection, e.g. "actors" (mounted under `/api`). */
  routeBase: string;
  /** snake_case prefix used in the generated MCP tool names, e.g. "actor" -> "foundry_list_actor_effects". */
  toolPrefix: string;
}

const documentDataSchema = z.record(z.string(), z.unknown());
const parentIdSchema = z.object({ parentId: z.string().min(1) });
const effectIdSchema = parentIdSchema.extend({ effectId: z.string().min(1) });
const createSchema = parentIdSchema.extend({ data: documentDataSchema });
const updateSchema = effectIdSchema.extend({ changes: documentDataSchema });

/**
 * Builds the five embedded-ActiveEffect CRUD descriptors for one parent
 * document type. REST: `GET/POST /<routeBase>/:parentId/effects`,
 * `GET/PUT/DELETE /<routeBase>/:parentId/effects/:effectId`.
 */
export function makeEmbeddedEffectEndpoints(
  config: EmbeddedEffectEndpointConfig,
): AnyEndpointDescriptor[] {
  const { parentType, routeBase, toolPrefix } = config;

  const listDescriptor: EndpointDescriptor<{ parentId: string }, DocumentData[]> = {
    name: `foundry_list_${toolPrefix}_effects`,
    description: `Lists every embedded ActiveEffect document on a ${parentType}.`,
    method: "get",
    path: `/${routeBase}/:parentId/effects`,
    inputSchema: parentIdSchema,
    handler: ({ parentId }, { foundryClient }) =>
      foundryClient.call<EffectParentInput, DocumentData[]>(EMBEDDED_EFFECT_COMMANDS.LIST, {
        parentType,
        parentId,
      }),
  };

  const getDescriptor: EndpointDescriptor<{ parentId: string; effectId: string }, DocumentData> = {
    name: `foundry_get_${toolPrefix}_effect`,
    description: `Reads a single embedded ActiveEffect document from a ${parentType} by id.`,
    method: "get",
    path: `/${routeBase}/:parentId/effects/:effectId`,
    inputSchema: effectIdSchema,
    handler: ({ parentId, effectId }, { foundryClient }) =>
      foundryClient.call<EffectIdInput, DocumentData>(EMBEDDED_EFFECT_COMMANDS.GET, {
        parentType,
        parentId,
        effectId,
      }),
  };

  const createDescriptor: EndpointDescriptor<
    { parentId: string; data: Record<string, unknown> },
    DocumentData
  > = {
    name: `foundry_create_${toolPrefix}_effect`,
    description: `Creates a new embedded ActiveEffect document on a ${parentType}.`,
    method: "post",
    path: `/${routeBase}/:parentId/effects`,
    inputSchema: createSchema,
    handler: ({ parentId, data }, { foundryClient }) =>
      foundryClient.call<EffectCreateInput, DocumentData>(EMBEDDED_EFFECT_COMMANDS.CREATE, {
        parentType,
        parentId,
        data,
      }),
  };

  const updateDescriptor: EndpointDescriptor<
    { parentId: string; effectId: string; changes: Record<string, unknown> },
    DocumentData
  > = {
    name: `foundry_update_${toolPrefix}_effect`,
    description: `Updates fields on an existing embedded ActiveEffect document on a ${parentType}.`,
    method: "put",
    path: `/${routeBase}/:parentId/effects/:effectId`,
    inputSchema: updateSchema,
    handler: ({ parentId, effectId, changes }, { foundryClient }) =>
      foundryClient.call<EffectUpdateInput, DocumentData>(EMBEDDED_EFFECT_COMMANDS.UPDATE, {
        parentType,
        parentId,
        effectId,
        changes,
      }),
  };

  const deleteDescriptor: EndpointDescriptor<
    { parentId: string; effectId: string },
    DocumentDeleteResult
  > = {
    name: `foundry_delete_${toolPrefix}_effect`,
    description: `Deletes an embedded ActiveEffect document from a ${parentType} by id.`,
    method: "delete",
    path: `/${routeBase}/:parentId/effects/:effectId`,
    inputSchema: effectIdSchema,
    handler: ({ parentId, effectId }, { foundryClient }) =>
      foundryClient.call<EffectIdInput, DocumentDeleteResult>(EMBEDDED_EFFECT_COMMANDS.DELETE, {
        parentType,
        parentId,
        effectId,
      }),
  };

  return [listDescriptor, getDescriptor, createDescriptor, updateDescriptor, deleteDescriptor];
}

export const activeEffectEndpointDescriptors: AnyEndpointDescriptor[] = [
  ...makeEmbeddedEffectEndpoints({ parentType: "Actor", routeBase: "actors", toolPrefix: "actor" }),
  ...makeEmbeddedEffectEndpoints({ parentType: "Item", routeBase: "items", toolPrefix: "item" }),
];
