# Foundry Local API + MCP — Build Plan

## Architecture (read this first)

Foundry module code runs inside the client's sandboxed browser/Electron
renderer. It has no Node.js access and cannot itself host an Express server.
So this project is **two cooperating processes**, both living in this repo:

- **`server/`** — a standalone Node.js process (`npm start`, run alongside
  Foundry, not loaded by it) hosting:
  - the Express REST API
  - an MCP server sharing the same backend logic
  - a WebSocket gateway that the in-Foundry module connects out to
- **`module/`** — the actual Foundry module (this folder's `module.json` at
  the repo root, client-side JS). Its only job is: open a WebSocket to the
  local server, receive `{command, payload}` messages, execute the real
  Foundry API call (`game.*`, `canvas.*`, Document CRUD, etc.) in-client, and
  return the result.

Every REST endpoint therefore has the same shape: `HTTP request → Express
route → FoundryClient.call(command, payload) → WS round-trip to the module →
Foundry API executes → result flows back → HTTP response`. The MCP server
reuses the identical `FoundryClient` and, from Phase 5 onward, every endpoint
is defined once as a shared descriptor that generates both the REST route
and the MCP tool, so the two surfaces can't drift apart.

This is high-privilege by nature (full remote control of a running game), so
security (local-only binding, API key, GM-only scopes) is set up early
(Phase 4) and re-audited at the end (Phase 29), not bolted on last.

Phases are intentionally small — each should be shippable and testable on
its own before moving to the next.

---

## Phase 0 — Repo & Tooling Foundation
- `git init` (done), `.gitignore` (node_modules, dist, .env, logs)
- `package.json` at repo root (npm workspaces: `server`, `module`, `shared`)
- TypeScript config, ESLint + Prettier
- `shared/` package for protocol types (message envelope, command names) used
  by both `server` and `module`
- README stub explaining the two-process architecture

## Phase 1 — Base Express Server Scaffold
- `server/src/index.ts` entrypoint, `.env`-based config (port, bind address)
- Express app: JSON body parsing, request logging, centralized error handler
- `GET /health` endpoint
- Binds to `127.0.0.1` by default; remote binding requires explicit opt-in
- Graceful shutdown (SIGINT/SIGTERM)

## Phase 2 — Foundry Module Bridge Client
- Client-side esmodule registered in `module.json`
- On the `ready` hook, opens a WebSocket to the local server
- Reconnect/backoff on disconnect; in-Foundry status indicator
- Message envelope `{id, type, payload}` / `{id, ok, result|error}`
- Command dispatcher registry so later phases just register handlers, no
  changes to the transport code

## Phase 3 — Bridge Transport Protocol & Server-Side WS Gateway
- `ws` server mounted at `/bridge` on the Express server
- `FoundryClient.call(command, payload)` — promise-based, correlation IDs,
  configurable timeout (default 10s)
- Single active world-connection model to start (documented limitation);
  reject/queue behavior for a second module connection is decided here
- Foundry-side thrown errors normalized into structured REST error bodies

## Phase 4 — Security Hardening Pass 1
- API key: generated on first run, stored in server config; required on
  every `/api/*` request via header
- CORS: deny-by-default, explicit allow-list
- Rate limiting middleware
- `zod`-based input validation wired into the route-handler pattern used by
  every phase from here on
- Request/command audit log

## Phase 5 — MCP Server Interface Scaffold
- `server/src/mcp/index.ts` using `@modelcontextprotocol/sdk`, same
  `FoundryClient` instance as the REST side
- stdio transport first (Claude Desktop/Code use), SSE transport as a later
  option
- **Endpoint descriptor pattern established here**: `{name, method, path,
  inputSchema, description, handler}` — one definition generates both the
  Express route and the MCP tool. All later phases use this, never hand-roll
  a route or a tool separately.
- First tool: `foundry_status`, mirroring `/health`

## Phase 6 — Core Meta/Introspection Endpoints (first full vertical slice)
- `GET /api/status`, `/api/world`, `/api/system`, `/api/user`, `/api/users`,
  `/api/modules`, `/api/settings` (enumerate, read-only)
- Matching MCP tools via the Phase 5 descriptor pattern
- Proves the full pipeline end-to-end; the integration test written here
  becomes the template every later phase copies

## Phase 7 — Settings Read/Write
- `GET/PUT /api/settings/:namespace/:key` → `game.settings.get/set`
- GM-only gating for world-scope settings
- MCP: `get_setting`, `set_setting`

## Phase 8 — Generic Document CRUD Core
- A generic Document abstraction in the module bridge driven by
  `game.collections` / `CONFIG.<Type>.documentClass`, since Foundry's
  Document API is uniform across types
- Route-factory + tool-factory: `makeDocumentEndpoints('JournalEntry')` etc.
- Proven first against `JournalEntry` (simplest document type, no embedded
  collections)

## Phase 9 — Actors
- `/api/actors` CRUD via the Phase 8 factory + actor-specific extras (roll
  data, `/api/actors/:id/items`)
- MCP tools mirrored

## Phase 10 — Items
- `/api/items` (world items) + embedded actor-item CRUD

## Phase 11 — Scenes
- `/api/scenes` CRUD, activate scene, grid/dimension info

## Phase 12 — Tokens (scene-embedded)
- `/api/scenes/:id/tokens` CRUD, move, visibility toggle

## Phase 13 — Journal Entries & Pages
- Full CRUD for `JournalEntry` + embedded `JournalEntryPage`

## Phase 14 — Dice Rolling & Chat Messages
- `POST /api/rolls` (Roll formula evaluation)
- `POST /api/chat`, `GET /api/chat` (recent log)
- MCP: `roll_dice`, `send_chat_message`

## Phase 15 — Macros
- CRUD + `POST /api/macros/:id/execute`
- Explicit "executes arbitrary JS" safety flag/scope on this tool

## Phase 16 — Combat & Combat Tracker
- `/api/combats` CRUD, start/next-turn/next-round/end, add/remove combatant,
  roll initiative

## Phase 17 — Playlists & Audio
- `/api/playlists` CRUD, play/stop/pause sound

## Phase 18 — RollTables & Cards
- CRUD + draw-from-table, card pile operations

## Phase 19 — Folders
- CRUD + move documents between folders

## Phase 20 — Compendium Packs
- List packs, read pack index, CRUD entries within a pack, import compendium
  entry into the world

## Phase 21 — Active Effects
- CRUD on embedded `ActiveEffect`s for actors/items

## Phase 22 — Canvas & Scene Placeables
- Drawings, Notes, AmbientLight, AmbientSound, Wall, MeasuredTemplate CRUD
- Camera pan/zoom control endpoint

## Phase 23 — Permissions & Ownership
- Get/set document ownership; world permission levels per user

## Phase 24 — File/Asset Management
- Browse `FilePicker` directories, upload files, create directories
  (respecting Foundry's upload security model)

## Phase 25 — Users & Client State
- User CRUD (GM only), active/idle status, current selection/targeting
  (`canvas.tokens.controlled`)

## Phase 26 — Hooks/Event Streaming
- Module subscribes to Foundry hooks (`createActor`, `updateToken`,
  `chatMessage`, etc.) and pushes them to the server
- Exposed over REST as `GET /api/events` (SSE) and over MCP as a
  subscribable resource/notification stream

## Phase 27 — Localization & Misc Utilities
- `GET /api/localize`, HTML enrichment, in-world search, if applicable

## Phase 28 — Bulk/Batch & Query Endpoints
- Generic filtered-query endpoint across document collections
- Batch create/update/delete to cut round-trips for larger operations

## Phase 29 — Security Review Pass
- Re-audit: localhost-only default, mandatory API key, GM-only scopes on
  privileged endpoints, rate limiting all still enforced now that ~100+
  endpoints exist
- Run the `security-review` skill before any "remote access" documentation
  is written

## Phase 30 — Documentation & Packaging
- Full README, OpenAPI spec generated from the endpoint descriptors, MCP
  tool catalog doc
- Finalize `module.json` (relationships, download URL), versioning,
  CHANGELOG
- Example usage: curl snippets + MCP client config

## Phase 31 — Test Suite & CI
- Unit tests for the descriptor→route/tool generator
- Integration tests against a mocked Foundry client
- Lint/test automation (GitHub Actions or local script)

---

## Notes for execution
- Each domain phase (9 onward) should start by inspecting the *live*
  Foundry V14 client console for the exact current API shape before coding
  against it — Foundry's Document API is stable in outline but field-level
  details shift between versions, and this plan targets whatever V14
  actually exposes at implementation time, not a frozen snapshot.
- Every phase = endpoint(s) + matching MCP tool(s) + test, per the user's
  requirement — never land a REST route without its MCP counterpart in the
  same phase.
