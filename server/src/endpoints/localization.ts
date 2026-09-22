// Phase 27 — Localization & Misc Utilities.
//
// Three hand-rolled, read-only-ish descriptors — none are document CRUD, so
// none run through the Phase 8 factory. See shared/src/localization.ts's
// header comment for the reasoning behind `search`'s narrow scope.
import { z } from "zod";

import {
  LOCALIZATION_COMMANDS,
  type EnrichHtmlInput,
  type EnrichHtmlResult,
  type LocalizeInput,
  type LocalizeResult,
  type SearchInput,
  type SearchResult,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

// `data` is a JSON-encoded object in the query string (e.g.
// `?data={"name":"Bob"}`, URL-encoded) — Express 5 defaults to the "simple"
// query parser (plain `querystring`, no bracket-notation nesting like
// Express 4's `qs`-backed "extended" parser), so a bracket-notation
// `data[name]=Bob` would arrive as a single literal key rather than a nested
// object. JSON-in-a-query-param is the standard workaround for putting a
// structured value on a GET request under that parser.
const localizeSchema = z.object({
  key: z.string().min(1),
  data: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) {
        return undefined;
      }
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        ctx.addIssue({ code: "custom", message: "`data` must be valid JSON", path: ["data"] });
        return z.NEVER;
      }
    }),
});

const enrichHtmlSchema = z.object({
  content: z.string(),
});

const searchSchema = z.object({
  query: z.string().min(1),
  types: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : value
            .split(",")
            .map((type) => type.trim())
            .filter((type) => type.length > 0),
    ),
});

const localizeDescriptor: EndpointDescriptor<LocalizeInput, LocalizeResult> = {
  name: "foundry_localize",
  description:
    "Resolves a localization key via game.i18n. With `data`, interpolates via game.i18n.format(); without it, plain game.i18n.localize().",
  method: "get",
  path: "/localize",
  inputSchema: localizeSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<LocalizeInput, LocalizeResult>(LOCALIZATION_COMMANDS.LOCALIZE, input),
};

const enrichHtmlDescriptor: EndpointDescriptor<EnrichHtmlInput, EnrichHtmlResult> = {
  name: "foundry_enrich_html",
  description:
    "Enriches raw HTML/content-link text (e.g. @UUID[...], @Actor[...], inline rolls) into resolved HTML via Foundry's TextEditor.enrichHTML().",
  method: "post",
  path: "/enrich-html",
  inputSchema: enrichHtmlSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<EnrichHtmlInput, EnrichHtmlResult>(LOCALIZATION_COMMANDS.ENRICH_HTML, input),
};

const searchDescriptor: EndpointDescriptor<SearchInput, SearchResult> = {
  name: "foundry_search",
  description:
    'Case-insensitive name-substring search across world document collections (game.collections). `types` optionally limits the search to a comma-separated list of document type names (e.g. "Actor,Item"); omit to search every collection.',
  method: "get",
  path: "/search",
  inputSchema: searchSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<SearchInput, SearchResult>(LOCALIZATION_COMMANDS.SEARCH, input),
};

export const localizationEndpointDescriptors: AnyEndpointDescriptor[] = [
  localizeDescriptor,
  enrichHtmlDescriptor,
  searchDescriptor,
];
