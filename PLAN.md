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
reuses the identical `FoundryClient`, and every endpoint is defined once as a
shared descriptor that generates both the REST route and the MCP tool, so the
two surfaces can't drift apart.

This is high-privilege by nature (full remote control of a running game), so
security (local-only binding, API key, GM-only scopes) was set up early
(Phase 4) and re-audited once the core surface was built (Phase 29).

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
| 7 — Settings Read/Write | ✅ Done | `c7dfa86` |
| 8 — Generic Document CRUD Core | ✅ Done | `e03d360` |
| 9 — Actors | ✅ Done | `9ee8cfb` |
| 10 — Items | ✅ Done | `22e7a8e` |
| 11 — Scenes | ✅ Done | `ea2f434` |
| 12 — Tokens (scene-embedded) | ✅ Done | `12b21e7` |
| 13 — Journal Entries & Pages | ✅ Done | `246c09e` |
| 14 — Dice Rolling & Chat Messages | ✅ Done | `844df5f` |
| 15 — Macros | ✅ Done | `43ef417` |
| 16 — Combat & Combat Tracker | ✅ Done | `7f1ee21` |
| 17 — Playlists & Audio | ✅ Done | `e4d1feb` |
| 18 — RollTables & Cards | ✅ Done | `403a873` |
| 19 — Folders | ✅ Done | `7493063` |
| 20 — Compendium Packs | ✅ Done | `a851624` |
| 21 — Active Effects | ✅ Done | `3669275` |
| 22 — Canvas & Scene Placeables | ✅ Done | `4d2a48a` |
| 23 — Permissions & Ownership | ✅ Done | `4d2a48a` |
| 24 — File/Asset Management | ✅ Done | `4d2a48a` |
| 25 — Users & Client State | ✅ Done | `3717107` |
| 26 — Hooks/Event Streaming | ✅ Done | `3717107` |
| 27 — Localization & Misc Utilities | ✅ Done | `3717107` |
| 28 — Bulk/Batch & Query Endpoints | ✅ Done | `25e2e26` |
| 29 — Security Review Pass | ✅ Done | `251c399` |
| 30 — Documentation & Packaging | ✅ Done | `a2869e1` |
| 31 — Test Suite & CI | ✅ Done | `e14a08d` |
| 32 — Optional Integration Plugin Framework | ✅ Done | `0cd10ed` |
| 33 — Manifest Declaration Convention | ✅ Done | `7cd946c` |
| 34 — dnd5e Integration: Detection & Read-Only Data | ✅ Done | `0d49eb4` |
| 35 — dnd5e Integration: Actions | ✅ Done | `125e159` |
| 36 — Integration Template & Second Example | ✅ Done | `e8aaa46` |
| 37 — Live Smoke-Test Pass | ✅ Done | `5378438` |
| 38 — Game Pause/Resume & Bridge Reconnect Fix | ✅ Done | `7b331a1` |
| 39 — Combatant Update | ⬜ Not started | — |
| 40 — Combat Turn/Round Navigation | ⬜ Not started | — |
| 41 — Scene Regions | ⬜ Not started | — |
| 42 — UI Notifications | ⬜ Not started | — |
| 43 — World Time / Calendar | ⬜ Not started | — |
| 44 — Token Targeting | ⬜ Not started | — |
| 45 — Chat Message Update/Delete | ⬜ Not started | — |
| 46 — Fog of War Reset | ⬜ Not started | — |

---

## Completed work summary (Phases 0–37)

Full deviation-log detail lives in git history (see the commits above); this
is the durable, load-bearing summary for anyone building Phase 38+.

- **0 — Repo & Tooling Foundation.** npm workspaces (`server`/`module`/
  `shared`), TypeScript + ESLint + Prettier, `shared/` protocol-types package.
- **1 — Base Express Server Scaffold.** Express app, `.env` config,
  `GET /health`, localhost-only bind by default, graceful shutdown.
- **2 — Foundry Module Bridge Client.** Client-side WebSocket with
  reconnect/backoff, `{id, type, payload}` message envelope, a command
  dispatch registry later phases just register into.
- **3 — Bridge Transport Protocol & Server-Side WS Gateway.** `/bridge` WS
  gateway; `FoundryClient.call(command, payload)` is a promise-based,
  correlation-id round-trip with a 10s default timeout.
- **4 — Security Hardening Pass 1.** Static `.env` API key, fail-closed on
  startup if unset; CORS deny-by-default allow-list; rate limiting; `zod`
  validation wired into every route from here on; the `/bridge` WS itself
  gated by the same key via `?apiKey=`.
- **5 — MCP Server Interface Scaffold.** MCP server sharing the same
  `FoundryClient`. **Established the endpoint-descriptor pattern** —
  `{name, method, path, inputSchema, description, handler}` generates both
  the REST route and the MCP tool — every later phase uses this.
- **6 — Core Meta/Introspection Endpoints.** `status`/`world`/`system`/
  `user`/`users`/`modules`/`settings` (read-only). First full vertical slice;
  its integration test became the template every later phase copies.
- **7 — Settings Read/Write.** `GET/PUT /api/settings/:namespace/:key`,
  GM-only gating for world-scope settings enforced module-side (the server
  has no notion of which Foundry user is calling, only the static API key).
- **8 — Generic Document CRUD Core.** `makeDocumentEndpoints(documentType)`
  factory drives list/get/create/update/delete for any type in
  `game.collections`, proven first against `JournalEntry`. Reused unchanged
  by nearly every later document-CRUD phase.
- **9 — Actors.** Factory CRUD + roll-data and embedded-items-list extras.
- **10 — Items.** Factory CRUD for world items + hand-rolled embedded
  actor-item CRUD (an embedded item has no top-level collection).
- **11 — Scenes.** Factory CRUD + activate + grid/dimension info (reads
  Foundry's own computed `Scene#grid`/`Scene#dimensions` rather than
  re-deriving pixel math).
- **12 — Tokens.** Fully hand-rolled (a Token has no top-level collection at
  all) — embedded CRUD + move + visibility toggle under
  `/api/scenes/:sceneId/tokens[/:tokenId]`.
- **13 — Journal Entries & Pages.** Factory CRUD for `JournalEntry` + hand-
  rolled embedded `JournalEntryPage` CRUD.
- **14 — Dice Rolling & Chat Messages.** `POST /api/rolls` (formula
  evaluation only, no chat post); `GET/POST /api/chat` (bounded recent log +
  send) — deliberately not full CRUD.
- **15 — Macros.** Factory CRUD + `execute`. First use of MCP tool
  `annotations` (`destructiveHint: true`) for a safety-flagged tool.
- **16 — Combat & Combat Tracker.** Factory CRUD + start/next-turn/
  next-round/end, embedded combatant add/remove (no update — see Phase 39),
  roll-initiative (specific ids, or `rollAll` when omitted).
- **17 — Playlists & Audio.** Factory CRUD + play/stop/pause a single sound.
  Foundry has no native "pause" method; it's replicated as an `update()`
  flipping `playing`/recording `pausedTime`, matching the core sidebar's own
  behavior. No `playAll`/`stopAll` (narrow reading of "play/stop/pause
  sound", singular).
- **18 — RollTables & Cards.** Factory CRUD for both + table `draw`; Cards
  `draw`/`shuffle`/`reset` (not `pass`/`deal` — narrow reading of "card pile
  operations").
- **19 — Folders.** Factory CRUD + a generic move-any-document-between-
  folders extra (`folderId: null` moves to root).
- **20 — Compendium Packs.** Fully hand-rolled (packs live on their own
  `game.packs`, not `game.collections`) — list packs, read a pack's index,
  get/create/update/delete a pack entry, import an entry into the world via
  Foundry's own `WorldCollection#importFromCompendium()`.
- **21 — Active Effects.** Embedded CRUD generalized across two parent types
  (Actor, Item) via one `parentType`-parameterized factory rather than
  duplicating per-parent code.
- **22 — Canvas & Scene Placeables.** One factory handles six embedded
  placeable types (Drawing, Note, AmbientLight, AmbientSound, Wall,
  MeasuredTemplate) via Foundry's generic `Scene#getEmbeddedCollection()`. A
  scene-independent camera pan/zoom endpoint (`canvas.animatePan()`) rides
  alongside. **Region (`RegionDocument`) was never added — see Phase 41.**
- **23 — Permissions & Ownership.** Generic per-document ownership get/set
  (`/api/documents/:documentType/:documentId/ownership`) + a narrow
  per-user world-role get/set (not full User CRUD — that's Phase 25).
- **24 — File/Asset Management.** `FilePicker` browse/upload (base64 in the
  JSON body — the bridge protocol is JSON-only end to end)/createDirectory;
  a thin pass-through to Foundry's own upload security model, not a
  reimplementation of it.
- **25 — Users & Client State.** Hand-rolled User get/create/update/delete,
  GM-only (list already existed from Phase 6); active/idle connection status;
  canvas **selection** (`canvas.tokens.controlled`) only — **targeting
  (`user.targets`) was deliberately skipped, see Phase 44.**
- **26 — Hooks/Event Streaming.** First phase where the module pushes
  unsolicited data: a new `BridgeEventMessage` kind, a curated hook list
  (actor/item/token create/update/delete, `createChatMessage`) forwarded to a
  server-side `FoundryEventBus`, exposed as `GET /api/events` (SSE) and a
  polling MCP tool (real MCP resource-subscription support doesn't exist in
  the installed SDK version).
- **27 — Localization & Misc Utilities.** `GET /api/localize`
  (localize + format, branching on whether interpolation `data` is given),
  HTML enrichment (`TextEditor.enrichHTML`), in-world case-insensitive name
  search across `game.collections`.
- **28 — Bulk/Batch & Query Endpoints.** Generic exact-match query + batch
  create/update/delete, calling Foundry's native
  `createDocuments()`/`updateDocuments()`/`deleteDocuments()` (one bridge
  round-trip per batch, not N).
- **29 — Security Review Pass.** Found and fixed two real gaps: missing
  `requireGM()` on set-ownership/set-role (Phase 23), and the 50mb JSON body
  limit (raised for Phase 24's upload) leaking to every route including
  unauthenticated `/health` — scoped to the upload route only, default
  dropped back to 2mb. Everything else audited clean.
- **30 — Documentation & Packaging.** OpenAPI spec + MCP tool catalog
  generated directly from the live descriptor list (`z.toJSONSchema()`, no
  extra dependency), so docs can't drift from the real server.
- **31 — Test Suite & CI.** Descriptor-generator unit tests, a global
  command-name-uniqueness test across all `shared/` command maps, partial
  module-side pure-logic tests (full `game`/`Hooks`/`WebSocket` mocking was
  ruled out of scope), GitHub Actions CI (typecheck → lint → format:check →
  test → build).
- **32 — Optional Integration Plugin Framework.** `Integration` interface
  (`detect()`, `minVersion`/`maxVersion`); the active set is re-evaluated on
  every bridge (re)connection. REST integration routes rebuild from scratch
  on change (Express can't unmount a route); MCP tools are individually
  `.remove()`-able. No server restart needed either way.
- **33 — Manifest Declaration Convention.** Paired `relationships.recommends`
  (Foundry-facing) + `flags["foundry-local-api"].optionalIntegrations`
  (loader-facing) entries per integration, plus `check-manifest-sync.ts` — a
  drift check with an `implemented: false` state for a declared-but-not-yet-
  built integration.
- **34 — dnd5e Integration: Detection & Read-Only Data.** Config/actor-sheet/
  inventory reads off live/derived actor data (`actor.system`, not just
  `toObject()`). Every field is read defensively (`?? 0`/fallback keys) since
  dnd5e's data shape isn't guaranteed stable across versions — confirmed
  necessary by Phase 37.
- **35 — dnd5e Integration: Actions.** Rolls, rest, spell-slot adjust, item
  use. `callFirstAvailableMethod()` tries a candidate list of method names
  per action so a call succeeds against whichever dnd5e version is actually
  connected.
- **36 — Integration Template & Second Example.** Extracted
  `integrations/_template/` (endpoints/index/README) as an out-of-band,
  never-imported reference for adding the next integration. pf2e named as a
  candidate, not built.
- **37 — Live Smoke-Test Pass.** First run against a real Foundry v14 /
  dnd5e 6.0.3 world. Found and fixed 4 real bugs, all in Phase 35's write
  actions: dnd5e 6.0.3's roll methods need a `(config, dialog, message)`
  object call shape, not the old positional args (fixed with a
  shape-fallback helper); `Item#use()` blocks on an interactive attack-roll
  dialog unless `{subsequentActions: false}` is passed; Foundry core's
  `Combat#endCombat()` always shows an unskippable confirm dialog, worked
  around by calling `combat.delete()` directly; roll-initiative crashes for
  a combatant with no linked scene token (documented as an expected-usage
  constraint, not fixed). Every core-API phase (6–28) and the dnd5e
  read-only phase (34) worked unchanged.

## Conventions established (apply these to Phase 38+)

- **Descriptor pattern first** (Phase 5): one `{name, method, path,
  inputSchema, description, handler}` generates both the REST route and the
  MCP tool. Only hand-roll a route/tool separately when the shape genuinely
  doesn't fit (e.g. SSE, which holds a connection open instead of resolving
  once).
- **Reuse `makeDocumentEndpoints(documentType)`** (Phase 8) for anything
  registered in `game.collections`; only hand-roll CRUD when a type has no
  top-level collection (embedded-only, like Token/JournalEntryPage/
  Combatant, or its own top-level map, like User/compendium packs).
- **Embedded-child routes** follow `/<parent-route>/:parentId/<child>[/
  :childId]` (Phase 10), and a `parentType`/`documentType` field in the
  payload generalizes a factory across multiple possible parents/types
  (Phase 21) instead of duplicating code per parent.
- **GM-only gating is enforced module-side** via `requireGM()` (checking
  `game.user.isGM`), never server-side — the server only ever knows the
  single static API key, never which Foundry user is calling.
- **`exactOptionalPropertyTypes` gotcha**: an optional field on a shared
  payload interface must be typed `field?: T | undefined`, not just
  `field?: T`, or the zod schema backing it won't typecheck against it.
- **`module/src/types/foundry-globals.d.ts` stays minimal and hand-rolled**
  (not the community `foundry-vtt-types` package) — add only the exact
  subset of `game.*`/`CONFIG`/`canvas.*` surface the new phase's handlers
  actually call.
- **Prefer a small hand-rolled helper over a new dependency** when one is
  close (`isVersionInRange()` instead of `semver`, `z.toJSONSchema()`
  instead of `zod-to-json-schema`).
- **MCP tool `annotations`** (`destructiveHint`, etc.) are advisory only per
  spec — always pair them with a plain-language warning in the tool's own
  `description` too.
- **Read a phase's own wording narrowly** (Phases 16/17/18/19/27/35) rather
  than building out every related method "while you're in there" — add the
  narrower thing first, note the broader option as a candidate.

---

## Phase 38 — Game Pause/Resume & Bridge Reconnect Fix

Done (`7b331a1`).

- `GET/POST /api/game/paused` wrapping `game.paused` /
  `Game#togglePause(paused, {broadcast: true})` — the "GAME PAUSED" banner
  shown to every connected client, distinct from Phase 17's single-sound
  pause.
- MCP: `foundry_get_game_paused`, `foundry_set_game_paused`.
- Bundled fix found while live-testing pause: `BridgeClient` had no way to
  pick up a corrected bridge URL/API key without a full page reload once
  connected. Added `BridgeClient#reconnect()` plus a generation counter so a
  discarded in-flight socket's late events can't race the new one, wired to
  the module settings form's `onChange`.

## Phase 39 — Combatant Update

Phase 16 added embedded Combatant create/remove only; there's no way to
change a combatant's fields without deleting and re-adding it.

- `PUT /api/combats/:id/combatants/:combatantId` wrapping the embedded
  Combatant's own `update()` (routes through its parent `Combat`, same
  pattern as every embedded document since Phase 10) — `defeated`, `hidden`,
  `initiative`, name override, etc.
- MCP: `foundry_update_combatant`.
- No new ambient declaration expected — an embedded Combatant is already a
  `FoundryDocument`.

## Phase 40 — Combat Turn/Round Navigation

Phase 16 added `start`/`next-turn`/`next-round`/`end` only; there's no way to
step backward.

- `POST /api/combats/:id/previous-turn`, `POST /api/combats/:id/previous-
  round` wrapping `Combat#previousTurn()`/`Combat#previousRound()`.
- MCP: `foundry_combat_previous_turn`, `foundry_combat_previous_round`.
- Check whether either method shows a blocking dialog the way Phase 37 found
  `endCombat()` did, before assuming a direct call is headless-safe.

## Phase 41 — Scene Regions

`RegionDocument` (Foundry v11+ Scene Regions) is a real embedded placeable
type that sits alongside the six Phase 22 already covers (Drawing, Note,
AmbientLight, AmbientSound, Wall, MeasuredTemplate) but was never added —
likely because it postdates when Phase 22 was scoped.

- Add `"Region"` as a seventh `documentType` to the Phase 22
  `makeEmbeddedPlaceableEndpoints()` factory — should need no new server-side
  code, only a new factory call.
- Confirm the connected world's core version actually supports Regions
  before assuming the ambient `Scene#getEmbeddedCollection("regions")`
  accessor exists; degrade gracefully (clear error, not a crash) on an older
  core version.
- MCP tools mirrored via the factory, same naming convention as the other
  six placeable types.

## Phase 42 — UI Notifications

No way currently to push a message to a connected client's screen outside of
chat — useful for an agent that wants to surface a status update to the GM
without polluting the chat log.

- `POST /api/notify {message, type: 'info'|'warn'|'error'}` wrapping
  `ui.notifications.notify(message, type)`.
- MCP: `foundry_notify`.
- New ambient declaration: a minimal `ui.notifications` surface in
  `foundry-globals.d.ts` (this project's first ambient `ui.*` declaration).

## Phase 43 — World Time / Calendar

`game.time.worldTime` (and advancing it) is untouched by any existing phase,
despite being relevant to rest mechanics and any calendar-aware system.

- `GET /api/world-time` wrapping `game.time.worldTime`.
- `POST /api/world-time/advance {seconds}` wrapping `Game#time.advance()`
  (GM-only, same `requireGM()` convention as Phase 7/25).
- MCP: `foundry_get_world_time`, `foundry_advance_world_time`.
- Verify against the connected core version whether `game.time` exposes a
  richer calendar API (added in later V12+ builds) worth a follow-up phase,
  or whether `worldTime`/`advance()` alone is what's actually there.

## Phase 44 — Token Targeting

Phase 25 explicitly built canvas *selection* (`canvas.tokens.controlled`)
and skipped *targeting* (`user.targets`) — but targeting is what most
systems' attack/save rolls actually key off.

- `GET /api/canvas/targets` wrapping `game.user.targets` (mirrors Phase 25's
  selection-read shape).
- `POST /api/canvas/targets {tokenIds}` wrapping `Token#setTarget()` per id
  (clear existing targets first, unless an `additive` flag is set).
- MCP: `foundry_get_targets`, `foundry_set_targets`.

## Phase 45 — Chat Message Update/Delete

Phase 14 deliberately scoped `ChatMessage` to create + bounded recent-read,
not full CRUD; there's now no way to edit or retract a message.

- `PUT/DELETE /api/chat/:id` — either reuse `DOCUMENT_COMMANDS` with
  `documentType: "ChatMessage"` (Phase 8's generic factory already covers
  update/delete; only list/get/create were deliberately narrowed in Phase
  14) or add matching hand-rolled extras in `chat.ts` — factory reuse is
  strongly preferred, check first whether it just works.
- MCP: `foundry_update_chat_message`, `foundry_delete_chat_message`.

## Phase 46 — Fog of War Reset

No way currently to clear a scene's explored fog-of-war.

- `POST /api/scenes/:id/reset-fog` wrapping `Scene#resetFog()`.
- MCP: `foundry_reset_scene_fog`.
- Confirm whether this needs to target the currently-viewed scene only
  (like Phase 22's camera pan) or can operate on any scene by id; Foundry's
  own method may only make sense for the active one.

---

## Backlog — noted, not scheduled

Lower-priority or more niche gaps surfaced during the same audit. Promote
any of these to a numbered phase on request.

- **Compendium pack lifecycle.** Phase 20 covers entries *within* an
  existing pack; creating/deleting/duplicating a pack itself
  (`CompendiumCollection.createCompendium()`) isn't covered.
- **Playlist `playAll`/`stopAll` and global audio volume** (`game.audio`).
  Deliberately narrowed out of Phase 17.
- **Cards `pass`/`deal`** (moving cards between two *other* stacks, or one
  stack to many). Deliberately narrowed out of Phase 18.
- **`game.users.activeGM` / primary-GM lookup.**
- **Adventure document import/export.**
- **Module enable/disable** via `core.moduleConfiguration` — technically
  reachable through the existing generic settings endpoint (Phase 7), but
  requires a world reload to take effect and wasn't built as a dedicated,
  documented action.
- **World shutdown / return-to-setup.** Administrative and destructive
  (drops every connected player); probably should **not** be exposed via
  this API at all rather than being a scheduling gap. Flagging for an
  explicit decision, not implementation.

---

## Notes for execution

- Each domain phase should start by inspecting the *live* Foundry client
  console for the exact current API shape before coding against it —
  Foundry's Document API is stable in outline but field-level details shift
  between versions (Phase 37 found this the hard way for dnd5e's roll
  methods).
- Every phase = endpoint(s) + matching MCP tool(s) + test — never land a
  REST route without its MCP counterpart in the same phase.
- Phases 39–46 are mutually independent domain additions (same shape as the
  original Phases 22–28 "Execution Batching"), except 39/40 both touch
  `combats.ts`/`shared/src/combats.ts` and should not be worked fully in
  parallel against each other.
