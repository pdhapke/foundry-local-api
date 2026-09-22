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

## Status

| Phase | Status | Commit |
|---|---|---|
| 0 — Repo & Tooling Foundation | ✅ Done | `607bc28` |
| 1 — Base Express Server Scaffold | ✅ Done | `a6d0d4d` |
| 2 — Foundry Module Bridge Client | ✅ Done | `ec7b9e8` |
| 3 — Bridge Transport Protocol & Server-Side WS Gateway | ✅ Done | `d3f2887` |
| 4 — Security Hardening Pass 1 | ✅ Done | `803f9cc` |
| 5 — MCP Server Interface Scaffold | ✅ Done | `50b1bb2` |
| 6 — Core Meta/Introspection Endpoints | ✅ Done | `2b1ab95` |
| 7 — Settings Read/Write | ⏳ Next up | — |
| 8–36 | Not started | — |

**Deviations from the original plan, decided along the way:**
- Phase 4's API key is a single static value from `.env`, auto-generated and
  persisted to `server/.env` on first startup (not the originally-sketched
  generate/rotate/admin-UI flow) — simplified per explicit user request.
- Phase 4 also closed a gap Phase 3 left open: the `/bridge` WebSocket had no
  auth at all, and combined with the "newest connection wins" policy, any
  local process could have hijacked the bridge. It's now gated by the same
  API key via a `?apiKey=` query param (a browser `WebSocket` can't set
  handshake headers).
- Phase 6 extended `module/src/types/foundry-globals.d.ts` with hand-rolled
  ambient declarations for `game.release`/`world`/`system`/`user`/`users`/
  `modules`/`settings.settings`, rather than adopting the community
  `@league-of-foundry-developers/foundry-vtt-types` package — that package is
  a large, sometimes version-mismatched type surface, and adopting it without
  a live instance to validate against was judged riskier than extending the
  existing minimal file with exactly what Phase 6 needs.
- Phase 6 was implemented and tested entirely against a mocked bridge client
  (`server/src/endpoints/meta.test.ts`) — no live Foundry instance was
  available. The module-side command handlers (`module/src/commands/meta.ts`)
  build/typecheck cleanly but are unverified against a real `game.*` object;
  flagged for a live smoke-test whenever a Foundry instance is available.

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
- API key: simple, static, set via `.env` (`API_KEY`); required on every
  `/api/*` request via header. No generation/rotation flow or settings UI —
  if `API_KEY` isn't set, the server refuses to start with a clear error
  (fail closed, never "no key means no auth")
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

---

## Part 2 — Optional Companion-Module Integrations

Phases 1–31 build the core API surface, which works against *any* Foundry
world regardless of installed system/modules. This part adds an
**integration framework**: extra endpoints and MCP tools that only appear
when a specific companion system or module is active in the connected
world — e.g. dnd5e-specific rolls and rest handling when the world's game
system is dnd5e. Core endpoints never depend on this; integrations are
strictly additive and independently togglable.

**Manifest note, correcting the initial framing:** Foundry's actual module
manifest schema has no field literally named `optionalRelationships`. The
real, Foundry-read field is `relationships.recommends` — an array of
`{id, type, reason}` entries meaning "not required, but this pairs well with
this module." `relationships.requires` is the hard-dependency form we are
*not* using here. `recommends` doesn't carry enough detail for our own
runtime to act on (no detection rule, no list of what it unlocks), so we
pair it with a second, Foundry-ignored, custom block:
`flags["foundry-local-api"].optionalIntegrations`, which is the actual
source of truth our code reads. `relationships.recommends` exists purely so
Foundry's own UI/package manager shows the pairing to a human; it is
documentation, not the mechanism.

## Phase 32 — Optional Integration Plugin Framework
- Define an `Integration` interface (shared type): `{id, kind: 'system' |
  'module', detect(activeSystemId, activeModuleIds): boolean, endpoints:
  EndpointDescriptor[], minVersion?, maxVersion?}`
- `integrations/` directory, one subfolder per integration, registered
  through one explicit list (not auto-discovery) so the active set is easy
  to audit
- Immediately after a bridge connection is (re-)established, the server
  calls the existing `/api/system` and `/api/modules` commands (Phase 6) to
  learn what's active, then evaluates every integration's `detect()`
- Integration routers mount/unmount dynamically as that active set changes
  (world reload, GM enabling/disabling a module) — never requires a server
  restart
- Unmounted integration routes 404 with a body naming the missing
  dependency, not a generic 500
- MCP: emit `notifications/tools/list_changed` whenever the active
  integration set changes, so a connected MCP client refreshes its tool list
  without reconnecting
- The Phase 30 OpenAPI/tool-catalog generator marks integration-gated
  endpoints distinctly from always-present core ones

## Phase 33 — Manifest Declaration Convention
- Every integration gets one `relationships.recommends` entry (Foundry-
  facing) and one matching `flags["foundry-local-api"].optionalIntegrations`
  entry (loader-facing) — see module.json for the dnd5e entries added as the
  reference example.
- Add `scripts/check-manifest-sync.ts` (or a unit test) that fails if an
  integration registered in the Phase 32 code registry has no matching
  manifest entry, or vice versa, so the two never drift as more integrations
  are added.

## Phase 34 — dnd5e Integration: Detection & Read-Only Data
- `detect`: `game.system.id === 'dnd5e'`
- Namespace: REST under `/api/integrations/dnd5e/*`, MCP tools prefixed
  `dnd5e_`
- Endpoints (read-only first, same "prove the slice" approach as Phase 6):
  - `GET /api/integrations/dnd5e/config` — relevant slices of `CONFIG.DND5E`
    (abilities, skills, damage types, condition types) so a caller doesn't
    need hardcoded dnd5e knowledge to interpret raw actor data
  - `GET /api/integrations/dnd5e/actors/:id/sheet` — structured summary:
    abilities, saves, skills, AC, HP, senses, currency, spell slots,
    class/level, proficiency bonus
  - `GET /api/integrations/dnd5e/actors/:id/inventory` — items with
    dnd5e-specific fields (equipped, attuned, quantity, activities)
- MCP tools: `dnd5e_get_config`, `dnd5e_get_actor_sheet`,
  `dnd5e_get_actor_inventory`

## Phase 35 — dnd5e Integration: Actions
- `POST /api/integrations/dnd5e/actors/:id/roll/ability-check {ability}`
- `POST /api/integrations/dnd5e/actors/:id/roll/saving-throw {ability}`
- `POST /api/integrations/dnd5e/actors/:id/roll/skill {skill}`
- `POST /api/integrations/dnd5e/actors/:id/roll/death-save`
- `POST /api/integrations/dnd5e/actors/:id/rest {type: 'short'|'long'}`
- `POST /api/integrations/dnd5e/actors/:id/spell-slots {level, delta}` —
  spend/restore a slot
- `POST /api/integrations/dnd5e/items/:id/use` — trigger an item/activity
  use (dnd5e's Activities system)
- MCP tools mirrored 1:1 (`dnd5e_roll_ability_check`, `dnd5e_rest`,
  `dnd5e_use_item`, ...)
- **Before implementing**: audit the actual method signatures on the
  installed dnd5e version in-console (`actor.rollAbilityTest` /
  `rollSavingThrow` / `rollSkill` / `rollDeathSave` / `shortRest` /
  `longRest`, item/activity usage). dnd5e's API has changed materially
  across its 2.x → 3.x → 4.x releases (see
  https://github.com/foundryvtt/dnd5e), so implement against whatever
  version is actually installed, not a remembered signature.

## Phase 36 — Integration Template & Second Example
- Extract Phase 34/35's structure into `integrations/_template/` so adding
  the next integration is fill-in-the-template, not bespoke work
- Candidate future integrations to note but not build yet: other game
  systems (e.g. pf2e), and utility modules with a useful public API — each
  just needs a `detect()` and an endpoint set following the same pattern
