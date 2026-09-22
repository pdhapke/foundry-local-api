# foundry-local-api

A FoundryVTT module that exposes a local REST API and an MCP server for
full remote control of a running Foundry world — document CRUD, tokens,
combat, dice rolling, canvas placeables, compendium packs, permissions,
file management, users, live event streaming, and more — plus a framework
for optional integrations with companion systems/modules (e.g. dnd5e,
planned for a future phase; not built yet — see
[Status](#project-status--versioning) below).

## Why two processes

FoundryVTT module code executes inside the client's sandboxed
browser/Electron renderer. It has no Node.js access, so it cannot itself
host an HTTP server. This project is therefore split into two cooperating
processes that live side by side in this one repo:

- **`server/`** is a standalone Node.js process you run alongside Foundry
  (not loaded by it). It hosts the Express REST API, an MCP server that
  shares the same backend logic, and a WebSocket gateway.
- **`module/`** is the actual Foundry module — the client-side JavaScript
  Foundry loads per `module.json`. Its job is to open a WebSocket
  connection out to the local server, receive `{command, payload}`
  messages, execute the corresponding Foundry API call in-client
  (`game.*`, `canvas.*`, Document CRUD, etc.), and send the result back.

Every REST/MCP call therefore makes the same round trip: an external client
hits the server, the server sends a command over the WebSocket bridge to
the connected Foundry client, Foundry executes it, and the result flows
back through the same path to the HTTP/MCP response. A `shared/` package
holds the protocol types (message envelope, command names, endpoint
descriptors) referenced by both processes so they can't drift apart.

Both surfaces — REST routes and MCP tools — are generated from the same
**endpoint descriptor** list (`server/src/endpoints/*.ts`,
`allEndpointDescriptors` in `server/src/endpoints/index.ts`), so they can
never drift out of sync with each other. This is also what
[`docs/openapi.json`](./docs/openapi.json) and
[`docs/mcp-tools.md`](./docs/mcp-tools.md) are generated from — see
[Generated docs](#generated-docs-openapi--mcp-tool-catalog) below.

See [PLAN.md](./PLAN.md) for the full phase-by-phase build plan (36 phases
across two parts: the core API surface, then an optional integration
framework for companion systems/modules like dnd5e) and its "Deviations
from the original plan" log, which documents every non-obvious design
decision made along the way.

## Project status & versioning

This project has **no public release yet**. Phases 0–30 (core API surface,
security review, documentation) are complete; Phase 31 (automated test
suite/CI) and Part 2 (Phases 32–36, the optional dnd5e integration) have
not started. `module.json`'s `version` is `0.1.0` accordingly — pre-1.0,
signaling "under active development, no stability guarantees" rather than
a finished, versioned release. There is also no `download` URL in
`module.json` yet (no hosting/release artifact exists); add one once this
is actually published somewhere.

## Workspace layout

npm workspaces, ESM throughout:

```
.
├── server/   @foundry-local-api/server  — standalone Node.js process (Express + WS gateway + MCP)
├── module/   @foundry-local-api/module  — Foundry client-side esmodule (WS bridge client)
├── shared/   @foundry-local-api/shared  — protocol types shared by server and module
├── docs/                                — generated OpenAPI spec + MCP tool catalog (see below)
├── tsconfig.base.json                   — shared strict TS config, extended by each workspace
├── tsconfig.json                        — root project-references file (editor/whole-repo builds)
├── eslint.config.js                     — ESLint v9 flat config (typescript-eslint + Prettier)
└── .prettierrc                          — formatting rules
```

## TypeScript setup

Every workspace has its own `tsconfig.json` extending the root
`tsconfig.base.json` (strict mode, ES2022, project references, Node-style
ESM resolution for `server`/`shared`; `module` overrides `module`/
`moduleResolution` to `ESNext`/`Bundler` and adds the `DOM` lib since it
runs in the browser, not Node). The root `tsconfig.json` is a references-only
file (`"files": []`) that wires the three workspace projects together for
editor tooling and `tsc -b`; the actual `build`/`typecheck` npm scripts run
per-workspace via `--workspaces --if-present`, which is sufficient on its
own and doesn't require the root file — it's kept for editor convenience
and future whole-repo builds.

## Installation & setup

Requires Node.js >= 20.

```sh
git clone <this repo>
cd foundry-local-api
npm install          # installs root + all three workspaces
npm run build         # tsc -b (server/shared) + esbuild bundle (module) in each workspace
```

Other useful root scripts:

```sh
npm run typecheck      # tsc --noEmit in each workspace
npm run lint            # ESLint across the repo
npm run format            # Prettier --write across the repo
npm run test                # unit tests (server workspace)
npm run generate:docs        # regenerate docs/openapi.json + docs/mcp-tools.md
```

### 1. Configure the server (`server/.env`)

Copy `server/.env.example` to `server/.env` and adjust as needed — every
variable is optional and documented inline in that file. The essentials:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3939` | TCP port the HTTP server listens on. |
| `HOST` | `127.0.0.1` | Bind address. Must be a loopback address unless `ALLOW_REMOTE_BIND=true`. |
| `ALLOW_REMOTE_BIND` | `false` | Opt-in to bind to a non-loopback address (LAN/`0.0.0.0`). Logs a loud warning when used. |
| `API_KEY` | *(auto-provisioned)* | Static key required on every `/api/*` request and `/bridge` connection. If left unset, the server generates one on first startup and writes it back into `server/.env` for you. |
| `CORS_ALLOWED_ORIGINS` | *(empty = deny all)* | Comma-separated list of origins allowed to make cross-origin browser requests to `/api/*`. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window (ms) applied to `/api/*`. |
| `RATE_LIMIT_MAX` | `100` | Max requests per window per client, applied to `/api/*`. |
| `MCP_STDIO` | `false` | Also start an MCP server on the process's own stdio — set this via your MCP client's server config, not by hand in `.env` (see [Connecting an MCP client](#connecting-an-mcp-client-eg-claude-desktopcode) below). |
| `NODE_ENV` | `development` | `development` \| `production` \| `test`. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period for in-flight requests during SIGINT/SIGTERM shutdown. |
| `BRIDGE_TIMEOUT_MS` | `10000` | How long the server waits for a response over the `/bridge` WebSocket before timing out. |

You don't need to set `API_KEY` yourself — just run the server once and it
will generate one. See [`server/src/config.ts`](./server/src/config.ts) for
the authoritative parsing/validation logic behind every variable above.

### 2. Install the module into Foundry

This repo's root `module.json` is a real Foundry module manifest
(`esmodules: ["module/dist/index.js"]`). Make this whole repo (or a symlink
to it) available under your Foundry installation's `Data/modules/`
directory as `foundry-local-api` — e.g. this repo cloned directly at
`<FoundryDataPath>/modules/foundry-local-api` — then enable "Foundry local
api and mcp" for your world from Foundry's **Manage Modules** screen. Make
sure `npm run build` has been run first so `module/dist/index.js` exists.

### 3. Run the server

```sh
cd server
npm start          # node dist/index.js — requires `npm run build` first
```

With Foundry running and the module enabled, the in-client bridge connects
out to the server automatically (default `ws://127.0.0.1:3939/bridge`). The
server logs a startup banner with the health/API URLs once it's listening.

## Connecting an MCP client (e.g. Claude Desktop/Code)

The server can also run its MCP interface over **stdio**, for MCP clients
that spawn the server process directly rather than talking HTTP —
controlled by the `MCP_STDIO` env var (see `server/src/mcp/index.ts` and
`server/src/mcp/create-mcp-server.ts`). When `MCP_STDIO=true`, stdout is
reserved exclusively for the MCP JSON-RPC stream, so the startup banner and
request logger move to stderr instead (see `server/src/index.ts`). The
underlying `McpServer` is the same one that would otherwise be reached over
HTTP — every REST endpoint's descriptor also registers as an MCP tool (see
[Generated docs](#generated-docs-openapi--mcp-tool-catalog)).

Point an MCP client at the **built** server (`server/dist/index.js`), e.g.
for Claude Desktop/Code's `mcpServers` config:

```json
{
  "mcpServers": {
    "foundry-local-api": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/foundry-local-api/server",
      "env": {
        "MCP_STDIO": "true"
      }
    }
  }
}
```

`cwd` matters: `server/src/config.ts` resolves `server/.env` relative to
the built file's own location, so as long as you run the built
`dist/index.js` from anywhere inside the `server/` package (or with `cwd`
set as above), it finds the same `.env`/API key the HTTP surface uses — no
separate configuration needed for the MCP path. Run `npm run build` in
`server/` first so `dist/index.js` exists.

## Examples

### REST: a curl request

```sh
curl http://127.0.0.1:3939/api/status \
  -H "X-Api-Key: $(grep -oP '(?<=^API_KEY=).*' server/.env)"
```

Or with the key pasted directly:

```sh
curl http://127.0.0.1:3939/api/status -H "X-Api-Key: <your API key>"
```

A write example — rolling dice:

```sh
curl -X POST http://127.0.0.1:3939/api/rolls \
  -H "X-Api-Key: <your API key>" \
  -H "Content-Type: application/json" \
  -d '{"formula": "2d6+3"}'
```

`GET /health` is the one unauthenticated route (liveness check only — no
API key, not rate-limited):

```sh
curl http://127.0.0.1:3939/health
```

### MCP: calling a tool

Every REST endpoint above is also available as an MCP tool with the same
input shape — e.g. `foundry_get_status` (no input) and `foundry_roll_dice`
(`{"formula": "2d6+3"}`, mirroring the curl example above). See
[`docs/mcp-tools.md`](./docs/mcp-tools.md) for the authoritative, generated
list of every tool name/description/input schema, grouped by resource.

## Generated docs: OpenAPI + MCP tool catalog

[`docs/openapi.json`](./docs/openapi.json) (OpenAPI 3.1) and
[`docs/mcp-tools.md`](./docs/mcp-tools.md) are both generated straight from
`allEndpointDescriptors` — the exact same descriptor list that
`server/src/endpoints/registry.ts` uses to mount real Express routes and
register real MCP tools — by
[`server/src/scripts/generate-docs.ts`](./server/src/scripts/generate-docs.ts).
They are checked into the repo (not build artifacts you need to generate
yourself to read them), but **must be regenerated whenever an endpoint
descriptor changes** so they don't drift from the real API surface:

```sh
npm run generate:docs
```

This walks every descriptor's zod `inputSchema` (converted to JSON Schema
via zod v4's own built-in `z.toJSONSchema()` — no extra dependency needed)
to build parameters/request bodies, groups operations by REST resource, and
folds in the two hand-rolled REST routes that don't go through the
descriptor pattern at all (`GET /health` and the `GET /api/events` SSE
stream — see their own header comments in `server/src/app.ts` and
`server/src/endpoints/events-sse.ts` for why).

## Security posture

This module grants **full remote control of a running Foundry game** —
document CRUD, macro execution (arbitrary JavaScript), file upload, user
role changes. Treat the API key with that in mind. Current posture, most
recently audited in Phase 29 (see PLAN.md's Phase 29 deviation-log entries
for the full write-up):

- **Localhost-only by default.** `server/src/config.ts` refuses to bind to
  a non-loopback `HOST` unless `ALLOW_REMOTE_BIND=true` is explicitly set
  (and logs a loud warning when it is).
- **API key required** on every `/api/*` request (`X-Api-Key` header) and
  every `/bridge` WebSocket connection (`?apiKey=` query param, since a
  browser `WebSocket` can't set custom handshake headers). Auto-provisioned
  on first run; compared with a timing-safe equality check
  (`server/src/security/api-key.ts`).
- **Rate limiting** (`express-rate-limit`) covers the entire `/api/*`
  chain — nothing is mounted around it.
- **CORS deny-by-default**: cross-origin browser requests to `/api/*` are
  rejected unless the origin is explicitly listed in
  `CORS_ALLOWED_ORIGINS`.
- **GM-only gating** on privilege-elevating writes: world-scope settings
  writes, user CRUD/role changes, and ownership grants all require the
  connected Foundry user to be a GM (enforced module-side, since only the
  connected module knows the current user's role — the server itself has
  no concept of "which Foundry user" beyond the single static API key).
- **No document-level permission checks** beyond that: the whole system
  trusts the single API key as a single privilege tier (equivalent to a
  GM's own client). This is a deliberate scope, not an oversight — see
  PLAN.md's Phase 4/29 deviation entries.
- **Error responses never leak internals**: 5xx responses return a fixed
  "Internal server error" string; the real error is only logged
  server-side.
- The **macro-execute** endpoint/tool runs arbitrary JavaScript with full
  Foundry client privileges and is flagged `destructiveHint: true` in its
  MCP tool annotations, plus an explicit warning in its description (MCP
  annotations are advisory only, not server-enforced).

Given all of the above, only expose this beyond localhost on a network you
fully trust, and treat the API key like any other high-privilege credential.

## CHANGELOG

See [CHANGELOG.md](./CHANGELOG.md) for a phase-by-phase summary of what's
shipped; see [PLAN.md](./PLAN.md) for the full build plan and its detailed
"Deviations from the original plan" log.
