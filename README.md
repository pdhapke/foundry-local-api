# foundry-local-api

A FoundryVTT module that exposes a local REST API and an MCP server for
remote access to a running Foundry world — document CRUD, tokens,
combat, dice rolling, canvas placeables, compendium packs, permissions,
file management, users, live event streaming, and more — plus a framework
for optional integrations with companion systems/modules. The optional
Trails of Destiny integration is deliberately read/resolve/preview-only;
it does not add gameplay or document mutation operations.

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

Both surfaces — REST routes and MCP tools — are generated from shared
**endpoint descriptors**: core descriptors under `server/src/endpoints/`
and optional descriptors under `server/src/integrations/`. This is also what
[`docs/openapi.json`](./docs/openapi.json) and
[`docs/mcp-tools.md`](./docs/mcp-tools.md) are generated from — see
[Generated docs](#generated-docs-openapi--mcp-tool-catalog) below.

See [PLAN.md](./PLAN.md) for the full phase-by-phase build plan (36 phases
across two parts: the core API surface, then an optional integration
framework for companion systems/modules like dnd5e) and its "Deviations
from the original plan" log, which documents every non-obvious design
decision made along the way.

## Project status & versioning

This project has **no public release yet**. The core API and optional
integration framework are implemented, including optional dnd5e,
digital-tabletops, and Trails of Destiny support. `module.json`'s `version`
is `0.1.0` accordingly — pre-1.0, signaling "under active development, no
stability guarantees" rather than a finished, versioned release. There is
also no `download` URL in `module.json` yet (no hosting/release artifact
exists); add one once this is actually published somewhere.

### Requirements-completion branch status

The `0.1.0` source tree includes typed REST/MCP surfaces for MCP-REQ-001
through MCP-REQ-013 plus explicit multi-client lanes, structured protocol
errors, durable audit/idempotency journals, and exact-ID test-fixture
manifests. This is not a claim that all thirteen ledger requirements are
complete. The runtime capability report deliberately marks incomplete
families as `partial`, and the campaign completion report records the exact
remaining acceptance and live-client gates. The complete automated source gate
currently passes 44 shared, 477 server, and 235 module tests. In particular,
Foundry's API does not provide database-isolated multi-document transactions;
the manifest reports `atomic: false`, identifies its semantics as strict
verified compensation, and rejects operations it cannot compensate.

The current source also includes an identity-bound remote client reload and a
GM-only, revision-checked Scene grid-alignment operation. Neither is proof of a
live activation: the selected browser must advertise the exact command before
dispatch, and a grid write verifies that unrelated Scene fields and every
embedded collection remain unchanged.

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
| `API_KEY` | *(auto-provisioned)* | Administrative key required on every `/api/*` and `/mcp` request. It is never sent to a Foundry browser and cannot authenticate `/bridge`. Player/TV browsers continue to use GM-authorized scoped enrollment. If left unset, the server generates one on first startup and writes it back into `server/.env` for you. |
| `CORS_ALLOWED_ORIGINS` | *(empty = deny all)* | Comma-separated list of origins allowed to make cross-origin browser requests to `/api/*`. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window (ms) applied to `/api/*`. |
| `RATE_LIMIT_MAX` | `100` | Max requests per window per client, applied to `/api/*`. |
| `MCP_STDIO` | `false` | Also start an MCP server on the process's own stdio — set this via your MCP client's server config, not by hand in `.env` (see [Connecting an MCP client](#connecting-an-mcp-client-eg-claude-desktopcode) below). |
| `MCP_REMOTE_API_KEY` | *(unset)* | Opens a second loopback listener that serves only `/mcp`. This key is accepted on `/mcp` and rejected on `/api`. It must differ from `API_KEY`. Leave unset to keep the public listener off. |
| `MCP_PUBLIC_PORT` | `3945` | Port for that `/mcp`-only listener. Always bound to `127.0.0.1`. Must differ from `PORT`. `3945` leaves `3940` and `3941` for the AI Dungeon Master companion. |
| `MCP_ALLOWED_HOSTS` | *(unset)* | Host allowlist for the public listener (`*.trycloudflare.com` style wildcards allowed). Also turns on loopback `Host` checks on the main listener. |
| `MCP_REMOTE_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window for the public `/mcp` listener only. |
| `MCP_REMOTE_RATE_LIMIT_MAX` | `120` | Max public `/mcp` requests per window per forwarded client. |
| `MCP_MAX_SESSIONS` | *(unset)* | Cap on concurrent MCP sessions, per listener. |
| `MCP_SESSION_IDLE_MS` | *(unset)* | Close MCP sessions that have been idle this long. A held SSE stream counts as active. |
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
automatically to the same hostname as the Foundry page, forcing port `3939`
and path `/bridge`. This preserves Foundry's host-only session-cookie boundary:
`localhost`, `127.0.0.1`, and IPv6 loopback are not silently mixed.

The GM browser needs no bridge credential or pairing step. The bridge receives
the ambient Foundry session cookie during the loopback WebSocket upgrade,
forwards only the `session` cookie to the matching allowlisted Foundry origin,
and independently checks `/game` plus Foundry's authenticated Socket.IO
session and `getJoinData` response. It grants the GM lane only when Foundry
confirms the exact world, exact user, and exact `GAMEMASTER` role. The `TV`
account is never promoted to this lane. Verification is repeated for every
new WebSocket connection and session material is not retained.

A player or TV browser must separately enable **Allow bounded remote control**,
then be enrolled by an authenticated GM call to
`foundry_issue_bridge_enrollment`. The server rotates a short-lived,
single-use `/bridge` credential bound to the exact user, browser client ID,
lane, protocol, and module version. Delivery through Foundry's targeted user
query is RSA-OAEP encrypted to an ephemeral, non-extractable browser key, so
neither player storage nor Foundry query-debug logs contain the plaintext
credential. Player and TV commands remain constrained by server allowlists.

#### Foundry child-process startup

A Foundry module runs in the browser and cannot launch an operating-system
process itself. This local Foundry installation therefore imports
`scripts/foundry-child-bootstrap.mjs` from `App/main.js`. The bootstrap starts
the built local API server as a direct child of Foundry's Node process with
inherited stdio. Foundry and the API consequently share one terminal, and a
normal Foundry shutdown terminates the API child as well.

The hook in `App/main.js` is installation-local and a Foundry core update may
replace that file. If that happens, reapply the small bootstrap import before
`App/main.mjs` is imported.

## Connecting an MCP client (e.g. Claude Desktop/Code)

The same tool catalog is available through three MCP transports. Core tools
are always registered. Optional integration tools, including the 13
`trails_*` tools, are listed only while the matching system/module is active
and satisfies its configured version range; catalog changes are propagated
to connected clients.

1. **In-process stdio (`MCP_STDIO=true`).** The main server owns the HTTP,
   bridge, and stdio connections in one process. This is convenient for one
   MCP client that launches the server itself. Stdout is reserved for MCP
   JSON-RPC; application logs move to stderr.
2. **Streamable HTTP (`/mcp`).** A running server accepts MCP Streamable HTTP
   sessions at `http://127.0.0.1:3939/mcp`. Requests use the same
   `X-Api-Key` header as REST, or `Authorization: Bearer`. Each session has
   an independent tool catalog and follows activation/deactivation changes
   until the session closes. A separate public listener can expose this one
   path through a tunnel; see [Exposing `/mcp` through a tunnel](#exposing-mcp-through-a-tunnel).
3. **Forwarding/remote stdio (`mcp-remote`).** An MCP client launches
   `server/dist/mcp-remote.js`, which does not bind another HTTP port or own a
   Foundry bridge. It forwards calls to an already-running local API server,
   authenticates with that server's configured API key, and periodically
   refreshes optional-integration availability. This is the appropriate
   stdio mode for additional clients sharing one running server.

For in-process stdio, point an MCP client at the **built** main server
(`server/dist/index.js`), e.g. for Claude Desktop/Code's `mcpServers` config:

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

For forwarding stdio, use the same configuration but change `args` to
`["dist/mcp-remote.js"]` and omit `MCP_STDIO`. Start the main local API server
separately first. Both stdio modes read the same `server/.env` configuration.

### Exposing `/mcp` through a tunnel

The administrative API key controls the whole game. A tunnel pointed at
`PORT` (3939) would also publish `/api`, `/health`, and the GM `/bridge`
WebSocket, and every proxied connection would look like loopback. This
server does not launch a tunnel — installation and UI for that stay with
[AI Dungeon Master](./docs/dot-private-tunnel-setup.md). What it does provide
is a second listener you can point an existing tunnel at.

Set `MCP_REMOTE_API_KEY` to a new secret (not `API_KEY`). The server then
listens on `127.0.0.1:3945` (`MCP_PUBLIC_PORT`) and serves **only** `POST`,
`GET`, and `DELETE /mcp`. That default stays clear of the AI Dungeon Master
companion, which already binds `127.0.0.1:3940` (`AI_DM_PORT`) and
`127.0.0.1:3941` (`AI_DM_CHATKIT_PORT`). `/api`, `/health`, extension routes, and any
WebSocket upgrade are rejected there. Authenticate with
`Authorization: Bearer <MCP_REMOTE_API_KEY>` or `X-Api-Key`. The
administrative `API_KEY` is not accepted on this listener, so it never has
to be copied into a cloud MCP client. The remote key is also accepted on
local `/mcp`, and it is rejected on `/api`.

Point the tunnel at `http://127.0.0.1:3945`, not at port 3939:

```sh
# Quick Cloudflare tunnel. The printed https://*.trycloudflare.com URL is the MCP host.
cloudflared tunnel --url http://127.0.0.1:3945

# Or ngrok, HTTP only, same target.
ngrok http 127.0.0.1:3945
```

A named cloudflared tunnel should ingress only that origin:

```yaml
ingress:
  - hostname: foundry-mcp.example.com
    service: http://127.0.0.1:3945
  - service: http_status:404
```

Then set `MCP_ALLOWED_HOSTS=foundry-mcp.example.com` (or
`*.trycloudflare.com` for quick tunnels). Requests whose `Host` or
`X-Forwarded-Host` is not on that list are rejected. Enabling remote MCP
or this list also makes the main listener refuse non-loopback `Host`
values, which blocks DNS rebinding against port 3939. `localhost`,
`127.0.0.1`, `::1`, and `*.localhost` keep working, including the Foundry
bridge.

Example cloud client (Bearer):

```json
{
  "mcpServers": {
    "foundry-local-api": {
      "url": "https://foundry-mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_REMOTE_API_KEY>"
      }
    }
  }
}
```

Remote `/mcp` requests are rate limited (`MCP_REMOTE_RATE_LIMIT_*`) without
turning on Express `trust proxy`. The bucket is the rightmost
`X-Forwarded-For` address, so a client cannot pick a new bucket by prefixing
that header. `CF-Connecting-IP` is used only when `X-Forwarded-For` is
absent. A raw TCP tunnel adds neither header and shares one bucket. Do not
TCP-forward port 3939: a raw tunnel to the main port is indistinguishable
from a local client. Forwarding port 3945 is safe even as raw TCP, because
that listener has no other routes.

`MCP_MAX_SESSIONS` and `MCP_SESSION_IDLE_MS` are optional caps. Each listener
counts sessions separately. An open SSE stream counts as active, so idle
expiry does not drop a connected client.

Direct use of `http://127.0.0.1:3939` is unchanged when those proxy headers
are absent: `/api` still requires `API_KEY`, local `/mcp` still accepts it,
and `/health` stays unauthenticated.

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

### Optional Trails of Destiny integration

When the active Foundry system is `trails-of-destiny` version 0.1.0 or newer,
13 additional REST operations are available below
`/api/integrations/trails-of-destiny`, with matching `trails_*` tools on all
three MCP transports. When the integration is inactive, those MCP tools are
absent and REST requests to that namespace return 404 with code
`INTEGRATION_INACTIVE`; core APIs continue to work.

This first integration surface is intentionally bounded. It reads redacted
configuration, actor, inventory, readiness, and allowlisted catalog data;
resolves an action roll with the Trails runtime RNG; and calculates
initiative, threat, damage, recovery, experience, and builder previews.
Preview/manual-boundary evidence is returned to the caller, but no operation
creates or updates Actors or Items, writes Combat initiative, spends
resources, applies damage/recovery/effects, posts chat, or persists builder
output. An issue-free preview is not authorization to mutate a world.

## Generated docs: OpenAPI + MCP tool catalog

[`docs/openapi.json`](./docs/openapi.json) (OpenAPI 3.1) and
[`docs/mcp-tools.md`](./docs/mcp-tools.md) are both generated straight from
the core descriptor list and registered optional-integration descriptor
lists — the same sources used to mount Express routes and register MCP tools —
by
[`server/src/scripts/generate-docs.ts`](./server/src/scripts/generate-docs.ts).
They are checked into the repo (not build artifacts you need to generate
yourself to read them), but **must be regenerated whenever an endpoint
descriptor changes** so they don't drift from the real API surface:

```sh
npm run generate:docs
```

This walks every descriptor's zod `inputSchema` (converted to JSON Schema
via zod v4's own built-in `z.toJSONSchema()` — no extra dependency needed)
to build parameters/request bodies, marks optional OpenAPI operations with
exact `x-integration` identity/kind metadata, groups operations by resource,
and
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
- **Separated authentication lanes.** The administrative API key is required
  on every `/api/*` and local `/mcp` request and is never sent to a Foundry
  browser. It is not accepted on the public MCP listener. The GM `/bridge`
  lane instead revalidates the browser's existing Foundry session against
  the allowlisted loopback Foundry server. API-key query authentication on
  `/bridge` is rejected.
- **Remote MCP is a separate listener.** When `MCP_REMOTE_API_KEY` is set,
  `127.0.0.1:MCP_PUBLIC_PORT` serves only `/mcp` and only that key. HTTP
  tunnels aimed at the main port are rejected (proxy headers fail closed,
  including WebSocket upgrades to `/bridge`). `trust proxy` is not enabled.
- **Rate limiting** (`express-rate-limit`) covers the entire `/api/*`
  chain, and separately the public `/mcp` listener. Nothing on `/api` is
  mounted around its limiter.
- **CORS deny-by-default**: cross-origin browser requests to `/api/*` are
  rejected unless the origin is explicitly listed in
  `CORS_ALLOWED_ORIGINS`.
- **GM-only gating** on privilege-elevating writes: world-scope settings
  writes, user CRUD/role changes, and ownership grants require the connected
  Foundry user to be the exact session-verified role-4 GM. Module-side checks
  remain defense in depth rather than the bridge authentication source.
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

Given all of the above, treat both API keys like high-privilege credentials.
The remote key is still full MCP control of the game; it only avoids
publishing the admin key and the non-MCP routes. Prefer a named tunnel
hostname in `MCP_ALLOWED_HOSTS` over leaving the Host check off.

## CHANGELOG

See [CHANGELOG.md](./CHANGELOG.md) for a phase-by-phase summary of what's
shipped; see [PLAN.md](./PLAN.md) for the full build plan and its detailed
"Deviations from the original plan" log.
