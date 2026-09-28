# Server architecture audit for a Trails optional-system integration

## Scope and current request flow

`foundry-local-api` is an npm workspace (Node >=20) with three packages: `shared/`, `module/`, and `server/`. The server exposes authenticated REST at `/api`, Streamable HTTP MCP at `/mcp`, optional in-process stdio MCP (`MCP_STDIO=true`), and an authenticated WebSocket bridge at `/bridge`.

The normal call path is:

1. A single `EndpointDescriptor` (`server/src/endpoints/types.ts`) supplies an MCP tool name/description, optional flat Zod input schema, optional REST method/path, annotations, and a handler.
2. REST: `server/src/routes/api.ts` mounts core descriptors with `mountRestEndpoints`; integration descriptors are dynamically mounted below `/api/integrations` by `server/src/integrations/router.ts`. `validateBody`/`validateQuery` (`server/src/middleware/validate.ts`) merge route params with body/query, so REST and MCP use the same flat argument shape.
3. MCP: `registerMcpTools` (`server/src/endpoints/registry.ts`) registers the same descriptors and returns `RegisteredTool` handles. Tool results are JSON serialized into MCP text content.
4. Descriptor handlers call `FoundryClient.call(command, payload)` (`server/src/bridge/foundry-client.ts`). It emits a correlated `BridgeRequest` through `BridgeGateway` (`server/src/bridge/gateway.ts`) to the connected Foundry browser module.
5. `module/src/bridge-client.ts` receives the request and calls `dispatch` in `module/src/command-registry.ts`; side-effect imports in `module/src/index.ts` register handlers from `module/src/commands/*.ts`. The response returns over the same WebSocket. Wire types live in `shared/src/protocol.ts`.

Production composition is in `server/src/index.ts`: it constructs `BridgeGateway`, `FoundryClient`, `IntegrationManager`, event bus, Express app, and optional stdio MCP. `server/src/app.ts` owns auth/CORS/rate limiting and the `/api` and `/mcp` mounts. `/health` is deliberately unauthenticated; `/api` uses CORS + rate limiting + API key; `/mcp` uses CORS + API key without REST rate limiting; `/bridge` takes the same key as `?apiKey=` because browser WebSockets cannot set the custom header.

## Existing optional-integration architecture

- Contract: `Integration` in `server/src/integrations/types.ts` has `id`, `kind: "system" | "module"`, `detect(activeSystemId, activeModuleIds)`, `endpoints`, and optional inclusive `minVersion`/`maxVersion`.
- Registry: `server/src/integrations/registry.ts` is the explicit source list, currently `dnd5eIntegration` and `dttIntegration`. Trails should be a new `kind: "system"` entry with `detect: activeSystemId === "trails"` if that is the system's verified Foundry id.
- Detection: `IntegrationManager.refresh()` in `server/src/integrations/manager.ts` calls `META_COMMANDS.SYSTEM` and `META_COMMANDS.MODULES` over the bridge, filters registered integrations, applies version bounds, diffs ids, and notifies listeners. `server/src/index.ts` refreshes after every bridge connection/reconnection.
- REST activation: `applyActiveIntegrations()` in `server/src/integrations/router.ts` rebuilds and swaps an Express router. Active descriptors mount normally; registered-but-inactive namespaces return 404 `INTEGRATION_INACTIVE`. Paths must start `/<integration-id>` and become `/api/integrations/<integration-id>/...`.
- MCP activation: `applyActiveIntegrationTools()` in `server/src/integrations/mcp-tools.ts` incrementally registers/removes tools and sends `notifications/tools/list_changed`. Tool names conventionally start `<integration-id>_`.
- Reference implementations: `server/src/integrations/dnd5e/{index,endpoints}.ts`, `shared/src/dnd5e.ts`, and `module/src/commands/dnd5e.ts` show a system integration end to end. `server/src/integrations/digital-tabletops/*` shows a module integration. `server/src/integrations/_template/README.md` is the maintained checklist/scaffold.
- Manifest convention: `module.json` declares each optional dependency twice: `relationships.recommends` for Foundry/users and `flags["foundry-local-api"].optionalIntegrations` for tooling. `server/src/scripts/check-manifest-sync.ts` compares implemented manifest entries with the code registry; `implemented: false` represents declared-but-not-built.

## Concrete Trails extension seams

Expected additions/edits, without prescribing the Trails endpoint set:

- `shared/src/trails.ts`: `TRAILS_COMMANDS` plus typed payload/result interfaces; re-export from `shared/src/index.ts`.
- `module/src/commands/trails.ts`: `registerCommand(...)` handlers that read/call the live Trails system API; add `import "./commands/trails.js"` to `module/src/index.ts`.
- `server/src/integrations/trails/index.ts`: `trailsIntegration` (`id`, `kind`, detection/version policy, descriptors).
- `server/src/integrations/trails/endpoints.ts`: flat Zod schemas and one descriptor per REST/MCP operation. Use paths `/trails/...`, names `trails_...`, and `annotations.destructiveHint` for mutations where applicable.
- `server/src/integrations/registry.ts`: explicitly import/register `trailsIntegration`.
- `module.json`: matching `optionalIntegrations` and `relationships.recommends` entries.
- `server/src/integrations/trails/endpoints.test.ts`: direct descriptor harness with fake `FoundryClient`, modeled on the dnd5e test.
- Regenerate `docs/openapi.json` and `docs/mcp-tools.md`; integration operations get `x-integration: {id, kind}` in OpenAPI.

No separate REST handler or MCP handler should be written for the same operation. The descriptor handler is the shared seam; Foundry-specific behavior belongs in the module command handler, and command names/types belong in `shared`.

## MCP transport gap that must be included in the implementation plan

Optional integration tools currently reach only the in-process `MCP_STDIO=true` server:

- `server/src/index.ts` subscribes `applyActiveIntegrationTools(...)` only after `connectMcpStdio(...)` succeeds.
- Each Streamable HTTP session in `server/src/mcp/http-transport.ts` calls `createMcpServer(...)`; `server/src/mcp/create-mcp-server.ts` registers only `allEndpointDescriptors` (core), not the manager's active integrations. Therefore `/mcp` sessions never expose dnd5e/digital-tabletops today and would not expose Trails.
- `server/src/mcp-remote.ts` -> `createHttpMcpServer` -> `registerHttpMcpTools` also uses only `allEndpointDescriptors`. If remote stdio is in scope, it needs an explicit integration catalog/active-state strategy and integration REST prefix support: `http-tool-client.ts` currently builds `${baseUrl}/api${descriptor.path}`, whereas integration routes require `${baseUrl}/api/integrations${descriptor.path}`.
- `server/src/integrations/mcp-tools.ts` stores `trackedTools` in one module-global `Map<string, RegisteredTool[]>`. That is safe only for one MCP server. Multiple HTTP MCP sessions require state per `McpServer` (for example a `WeakMap<McpServer, Map<...>>`) plus cleanup, or integration descriptors must be registered into each newly created session from a supplied active-set snapshot. Otherwise one session can suppress/remove another session's registrations.

Recommended architecture change before/with Trails: make MCP server creation accept the active integration snapshot, register it on every new stdio/HTTP session, and maintain per-server subscriptions/handles for future active-set changes. Add an HTTP transport test proving an active integration is listed/callable and is removed/notified when it becomes inactive. Decide explicitly whether `mcp-remote` must dynamically mirror optional integrations; do not imply support in docs until it does.

## Tests, docs, and verification

Relevant existing coverage:

- Detection/version/diffing: `server/src/integrations/manager.test.ts`, `version.test.ts`.
- Dynamic REST gating: `server/src/integrations/router.test.ts`.
- Dynamic MCP add/remove/list-changed: `server/src/integrations/mcp-tools.test.ts` (single fake server only; extend for multiple servers).
- Per-integration REST/bridge mapping: `server/src/integrations/dnd5e/endpoints.test.ts` and `digital-tabletops/endpoints.test.ts`.
- Manifest consistency: `server/src/scripts/check-manifest-sync.test.ts`.
- Shared command-map conventions: `shared/src/commands.test.ts`.
- Docs generation: `server/src/scripts/generate-docs.ts` walks both core descriptors and `integrations`; output is `docs/openapi.json` and `docs/mcp-tools.md`. The displayed “Total tools” currently counts core descriptors only even though integration sections follow.

From repository root:

```text
npm run generate:docs
npm run check-manifest-sync
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check, tests, manifest sync, and build on Node 20. The integration template recommends the same full pass. For focused iteration: `npm test --workspace=server` and `npm test --workspace=shared` / `module`.

## Risks and planning constraints

- Verify the exact Trails system id, supported version range, document/data paths, public methods, permissions, and return shapes against the installed Trails source/live world before freezing schemas. Avoid copying dnd5e field assumptions.
- Module command imports are unconditional. A Trails command module must not dereference Trails-only globals/API at import time; gate inside handlers. Server-side activation prevents normal calls in other systems, but safe imports preserve core operation everywhere.
- Integration detection happens asynchronously after bridge connection. Before first successful refresh, registered integration REST namespaces are inactive. On disconnect, the current active array/routes are not cleared; calls then fail through `FoundryClient` as not connected. Treat this as existing behavior when writing lifecycle tests.
- Express/MCP inputs must remain flat `ZodObject`s. Path params are merged with body/query; nested/object query values have special serialization concerns in `http-tool-client.ts`.
- Mutating operations need precise annotations/descriptions and tests for validation/error mapping. Foundry handler errors currently become generic bridge `HANDLER_ERROR`, so preserve actionable messages without leaking secrets.
- The working tree already contains uncommitted server/MCP changes, including the Streamable HTTP and forwarding-server files. Implementation agents must preserve and account for those changes rather than assuming a clean baseline.
- Live smoke tests are materially important for a system integration; unit tests prove routing and payload mapping, not Trails API compatibility.

## Audit completion

`SERVER_ARCHITECTURE_AUDIT_COMPLETE: 2026-09-26`
