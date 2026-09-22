// Phase 30 — Documentation & Packaging.
//
// Walks `allEndpointDescriptors` (the same descriptor list that already
// generates every REST route and MCP tool — see server/src/endpoints/
// registry.ts) and emits two generated, checked-in artifacts from that one
// source of truth:
//   - docs/openapi.json  — an OpenAPI 3.1 document (paths/methods/schemas)
//   - docs/mcp-tools.md  — a human-readable MCP tool catalog, grouped by
//     REST resource
//
// This is build tooling, not server runtime code: it never ships in
// `dist/` output that the running server needs, it's invoked ad hoc via
// `npm run generate:docs` (see server/package.json), and it deliberately
// lives under `src/scripts/` (rather than a sibling `server/scripts/` with
// its own tsconfig) so it participates in the server workspace's existing
// `typecheck`/`lint`/`tsx` tooling for free.
//
// Schema conversion uses zod v4's own built-in `z.toJSONSchema()` (the
// project already depends on zod ^4.6.5) rather than adding the
// `zod-to-json-schema` package — zod 4 shipped native JSON Schema
// generation, so a third-party dependency for this would just be
// redundant.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z, type ZodType } from "zod";

// Side-effect-only import, and deliberately first: `../endpoints/index.js`
// (imported below) transitively depends on `../app.js` (via
// `endpoints/events.ts` -> `../app.js`), which itself imports
// `../routes/api.js`, which imports `../endpoints/index.js` back — a real
// circular import. It's harmless in the actual server because
// `server/src/index.ts` always enters via `../app.js` first, so by the time
// that cycle reaches `../routes/api.js`'s top-level `mountRestEndpoints
// (apiRouter, allEndpointDescriptors)`, `../endpoints/index.js` has always
// already fully finished evaluating. This script instead wants
// `allEndpointDescriptors` as its *entry point*, the opposite direction, so
// without this it hits that same `mountRestEndpoints` call before
// `allEndpointDescriptors` is initialized (a TDZ `ReferenceError`). Forcing
// `../app.js` to be evaluated first reproduces the production ordering.
import "../app.js";
import { allEndpointDescriptors } from "../endpoints/index.js";
import type { AnyEndpointDescriptor } from "../endpoints/types.js";
import { readPackageVersion } from "../version.js";

// Mirrors `server/src/middleware/auth.ts`'s `API_KEY_HEADER` rather than
// importing it, to keep this script's import graph minimal now that it
// already has to reason about one circular-import workaround above.
const API_KEY_HEADER = "x-api-key";

// This file lives at server/src/scripts/generate-docs.ts; the repo root
// (where docs/ lives) is three directories up, whether run via `tsx` against
// `src/` or (in principle) against a built `dist/` copy at the same depth.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOCS_DIR = join(REPO_ROOT, "docs");

type JsonSchemaObject = Record<string, unknown>;

/**
 * Converts a descriptor's zod `inputSchema` to a JSON Schema object.
 * `io: "input"` asks for the pre-`.transform()`/`.coerce` shape (what a
 * caller actually sends — e.g. `chat.ts`/`events.ts`'s `limit:
 * z.coerce.number()...` should document as accepting a string-or-number
 * query value, not the coerced `number` it produces) rather than the
 * default `io: "output"`, which describes the post-parse result type.
 * `unrepresentable: "any"` covers the handful of schemas zod genuinely
 * can't express as JSON Schema at all (e.g. `localization.ts`'s
 * `.transform()` pipelines) by falling back to an open `{}` schema for just
 * that piece, rather than throwing and aborting generation entirely.
 */
function toInputJsonSchema(schema: ZodType): JsonSchemaObject {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  }) as JsonSchemaObject;
}

/** Narrow an unknown JSON-Schema-shaped value's `properties` down to a plain record, defensively. */
function propertiesOf(schema: JsonSchemaObject): Record<string, JsonSchemaObject> {
  const props = schema["properties"];
  if (typeof props !== "object" || props === null) {
    return {};
  }
  return props as Record<string, JsonSchemaObject>;
}

function requiredOf(schema: JsonSchemaObject): string[] {
  const req = schema["required"];
  return Array.isArray(req) ? req.filter((v): v is string => typeof v === "string") : [];
}

/** Route params like `/scenes/:sceneId/tokens/:tokenId` -> `["sceneId", "tokenId"]`. */
function extractPathParamNames(path: string): string[] {
  const matches = path.matchAll(/:([A-Za-z0-9_]+)/g);
  return Array.from(matches, (m) => m[1] as string);
}

/** Express `:param` syntax -> OpenAPI `{param}` syntax. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/**
 * Groups descriptors by REST resource for both the OpenAPI `tags` array and
 * the MCP catalog's markdown sections. There's no explicit "domain" field on
 * `EndpointDescriptor` (and adding one to all ~29 endpoint files is out of
 * scope for a docs-only phase), so this derives a reasonable grouping
 * key purely from data that's already there: the route's first static path
 * segment (e.g. `/actors/:id/roll-data` and `/actors/:id/items` both group
 * under `actors`), or — for the one descriptor with no REST wiring at all
 * (`foundry_status`, see server/src/endpoints/health.ts) — a `meta` fallback.
 */
function tagFor(descriptor: AnyEndpointDescriptor): string {
  if (!descriptor.path) {
    return "meta";
  }
  const firstSegment = descriptor.path.split("/").filter(Boolean)[0];
  return firstSegment ?? "misc";
}

interface OpenApiParameter {
  name: string;
  in: "path" | "query";
  required: boolean;
  schema: JsonSchemaObject;
  description?: string;
}

function buildOperation(descriptor: AnyEndpointDescriptor, method: string, path: string): JsonSchemaObject {
  const pathParamNames = extractPathParamNames(path);
  const fullSchema = descriptor.inputSchema ? toInputJsonSchema(descriptor.inputSchema) : undefined;
  const allProperties = fullSchema ? propertiesOf(fullSchema) : {};
  const requiredNames = fullSchema ? requiredOf(fullSchema) : [];

  const parameters: OpenApiParameter[] = pathParamNames.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: allProperties[name] ?? { type: "string" },
  }));

  const bodyPropertyEntries = Object.entries(allProperties).filter(
    ([name]) => !pathParamNames.includes(name),
  );

  const isBodyMethod = method === "post" || method === "put";

  if (!isBodyMethod) {
    for (const [name, schema] of bodyPropertyEntries) {
      parameters.push({
        name,
        in: "query",
        required: requiredNames.includes(name),
        schema,
      });
    }
  }

  const requestBody =
    isBodyMethod && bodyPropertyEntries.length > 0
      ? {
          required: bodyPropertyEntries.some(([name]) => requiredNames.includes(name)),
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: Object.fromEntries(bodyPropertyEntries),
                required: requiredNames.filter((name) => !pathParamNames.includes(name)),
              },
            },
          },
        }
      : undefined;

  const dangerNote = descriptor.annotations?.destructiveHint
    ? "\n\n**Warning:** this operation is destructive/irreversible (see MCP tool annotations)."
    : "";

  return {
    operationId: descriptor.name,
    summary: descriptor.description.split(/(?<=[.!?])\s/)[0],
    description: descriptor.description + dangerNote,
    tags: [tagFor(descriptor)],
    security: [{ apiKeyAuth: [] }],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: {
      "200": {
        description: "Success.",
        content: { "application/json": { schema: {} } },
      },
      "400": { $ref: "#/components/responses/ValidationError" },
      "401": { $ref: "#/components/responses/Unauthorized" },
      "429": { $ref: "#/components/responses/RateLimited" },
      "500": { $ref: "#/components/responses/ServerError" },
    },
  };
}

function buildOpenApiDocument(): JsonSchemaObject {
  const paths: Record<string, JsonSchemaObject> = {};

  for (const descriptor of allEndpointDescriptors) {
    if (!descriptor.method || !descriptor.path) {
      continue; // MCP-only, e.g. foundry_status — see health.ts.
    }
    const openApiPath = "/api" + toOpenApiPath(descriptor.path);
    const pathItem = (paths[openApiPath] ??= {});
    pathItem[descriptor.method] = buildOperation(descriptor, descriptor.method, descriptor.path);
  }

  // Two hand-rolled REST routes that don't go through the descriptor
  // pattern at all (see their own header comments: server/src/endpoints/
  // health.ts's actual `/health` route lives in app.ts, and events-sse.ts
  // explains why SSE can't be a plain descriptor), added here by hand so
  // the generated spec still covers 100% of the server's real REST surface.
  paths["/health"] = {
    get: {
      operationId: "health",
      summary: "Liveness check.",
      description:
        "Unauthenticated liveness check — status/uptime/version. Does not require an API key and is not rate-limited.",
      tags: ["meta"],
      security: [],
      responses: {
        "200": {
          description: "Success.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", const: "ok" },
                  uptime: { type: "number" },
                  version: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  };
  paths["/api/events"] = {
    get: {
      operationId: "foundry_events_stream",
      summary: "Server-Sent Events stream of Foundry hook events.",
      description:
        "Long-lived Server-Sent Events (SSE) stream of Foundry hook events (Phase 26). Hand-rolled outside the descriptor pattern " +
        "because SSE needs to hold the connection open rather than return a single JSON response — see " +
        "server/src/endpoints/events-sse.ts. Not exposed as an MCP tool (MCP has no streaming-response primitive here); " +
        "the equivalent polling MCP tool is `foundry_get_recent_events`.",
      tags: ["events"],
      security: [{ apiKeyAuth: [] }],
      responses: {
        "200": {
          description: "text/event-stream of `{event: string, data: object}` frames.",
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
        "503": {
          description: "No event bus is currently wired up on this server.",
          content: { "application/json": { schema: {} } },
        },
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Foundry Local API",
      version: readPackageVersion(),
      description:
        "REST API for full remote control of a running Foundry VTT world, generated from the server's endpoint " +
        "descriptors (server/src/endpoints/*.ts) by server/src/scripts/generate-docs.ts. Every operation here also " +
        "exists as an MCP tool with an identical input shape — see docs/mcp-tools.md. See PLAN.md's Phase 29 for the " +
        "current security posture (localhost-only bind by default, static API key, rate limiting).",
    },
    servers: [{ url: "http://127.0.0.1:3939", description: "Default local server (PORT/HOST configurable via .env)" }],
    security: [{ apiKeyAuth: [] }],
    tags: Array.from(new Set(allEndpointDescriptors.map(tagFor)))
      .sort()
      .map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        apiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: API_KEY_HEADER,
          description: "Static API key (see server/.env.example's API_KEY, auto-provisioned on first startup).",
        },
      },
      responses: {
        ValidationError: {
          description: "Request failed zod input validation.",
          content: { "application/json": { schema: {} } },
        },
        Unauthorized: {
          description: `Missing or invalid API key. Provide it via the "${API_KEY_HEADER}" header.`,
          content: { "application/json": { schema: {} } },
        },
        RateLimited: {
          description: "Too many requests in the current rate-limit window.",
          content: { "application/json": { schema: {} } },
        },
        ServerError: {
          description: "Internal server error (message intentionally generic — see PLAN.md Phase 29).",
          content: { "application/json": { schema: {} } },
        },
      },
    },
  };
}

function formatJsonSchemaForMarkdown(descriptor: AnyEndpointDescriptor): string {
  if (!descriptor.inputSchema) {
    return "_No input._";
  }
  const schema = toInputJsonSchema(descriptor.inputSchema);
  const props = propertiesOf(schema);
  const required = new Set(requiredOf(schema));
  const names = Object.keys(props);
  if (names.length === 0) {
    return "_No input._";
  }
  const rows = names.map((name) => {
    const propSchema = props[name] ?? {};
    const type = (propSchema["type"] as string | string[] | undefined) ?? "any";
    const typeLabel = Array.isArray(type) ? type.join(" \\| ") : type;
    const desc = (propSchema["description"] as string | undefined) ?? "";
    return `| \`${name}\` | ${typeLabel} | ${required.has(name) ? "yes" : "no"} | ${desc} |`;
  });
  return ["| Field | Type | Required | Description |", "|---|---|---|---|", ...rows].join("\n");
}

function buildMcpToolCatalogMarkdown(): string {
  const byTag = new Map<string, AnyEndpointDescriptor[]>();
  for (const descriptor of allEndpointDescriptors) {
    const tag = tagFor(descriptor);
    const list = byTag.get(tag) ?? [];
    list.push(descriptor);
    byTag.set(tag, list);
  }

  const lines: string[] = [
    "# MCP Tool Catalog",
    "",
    "Generated from `allEndpointDescriptors` (server/src/endpoints/index.ts) by " +
      "`server/src/scripts/generate-docs.ts` — do not hand-edit; run `npm run generate:docs` " +
      "(from `server/`, or `npm run generate:docs --workspace=server` from the repo root) to regenerate. " +
      "Every tool listed here is also a REST endpoint with the same input shape — see `docs/openapi.json` " +
      "and the root README's Examples section.",
    "",
    `Total tools: **${allEndpointDescriptors.length}**.`,
    "",
    "## Contents",
    "",
    ...Array.from(byTag.keys())
      .sort()
      .map((tag) => `- [${tag}](#${tag})`),
    "",
  ];

  for (const tag of Array.from(byTag.keys()).sort()) {
    lines.push(`## ${tag}`, "");
    const descriptors = byTag.get(tag) ?? [];
    for (const descriptor of descriptors.sort((a, b) => a.name.localeCompare(b.name))) {
      const restLine =
        descriptor.method && descriptor.path
          ? `${descriptor.method.toUpperCase()} /api${descriptor.path}`
          : "(MCP only — no REST route)";
      const danger = descriptor.annotations?.destructiveHint ? " ⚠️ **destructive**" : "";
      lines.push(
        `### \`${descriptor.name}\`${danger}`,
        "",
        descriptor.description,
        "",
        `REST: \`${restLine}\``,
        "",
        formatJsonSchemaForMarkdown(descriptor),
        "",
      );
    }
  }

  return lines.join("\n") + "\n";
}

function main(): void {
  mkdirSync(DOCS_DIR, { recursive: true });

  const openApiDoc = buildOpenApiDocument();
  const openApiPath = join(DOCS_DIR, "openapi.json");
  writeFileSync(openApiPath, JSON.stringify(openApiDoc, null, 2) + "\n", "utf8");

  const mcpDocsPath = join(DOCS_DIR, "mcp-tools.md");
  writeFileSync(mcpDocsPath, buildMcpToolCatalogMarkdown(), "utf8");

  console.log(`Wrote ${openApiPath}`);
  console.log(`Wrote ${mcpDocsPath}`);
}

main();
