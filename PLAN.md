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

The MCP requirements extension (MCP-REQ-001 through 013) is integrated in
the `0.1.0` source and generated tool catalog. Independent QA still classifies
every family as partial or implemented-but-not-live-verified; no requirement
is considered complete until the dedicated live Foundry fixtures and separate
GM/Izzy/TV clients satisfy its full ledger acceptance. See
`campaign/reports/mcp-requirements-completion.md` at the workspace root.

### Phase 0R — scoped player/TV enrollment

The administrative key is now confined to the GM lane. Consenting player and
TV clients receive a rotated, short-lived, one-time `/bridge` credential bound
to their exact Foundry user, browser client ID, lane, protocol, and module
version. The target browser supplies an ephemeral RSA-OAEP public key through
Foundry's authenticated user query; only ciphertext crosses that query, and the
non-extractable private key stays in browser memory. The gateway enforces
advertised-capability/allowlist intersection, replay and duplicate rejection,
disconnect/restart invalidation, and secrecy-safe diagnostics.

Source tests and independent security review pass. Live Phase 0R remains
blocked until the real GM, Izzy, and TV tabs reload the built bundle; no fixture
work may begin before all three lanes appear in fresh REST and MCP capability
reports.

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
| 39 — Combatant Update | ✅ Done | `4b15288` |
| 40 — Combat Turn/Round Navigation | ✅ Done | `4b15288` |
| 41 — Scene Regions | ✅ Done | `cb78b30` |
| 42 — UI Notifications | ✅ Done | `9b6a038` |
| 43 — World Time / Calendar | ✅ Done | `cb78b30` |
| 44 — Token Targeting | ✅ Done | `cb78b30` |
| 45 — Chat Message Update/Delete | ✅ Done | `cb78b30` |
| 46 — Fog of War Reset | ✅ Done | `cb78b30` |
| 47 — Broadcast Camera View to All Players | ✅ Done | `cb78b30` |
| 48 — Playlist playAll/stopAll | ✅ Done | `9232324` |
| 49 — Cards Pass/Deal | ✅ Done | `9232324` |
| 50 — Active GM Lookup | ✅ Done | `9232324` |
| 51 — Compendium Pack Lifecycle | ✅ Done | `9382d08` |
| 52 — Digital TableTops Integration (Battlemap Control) | ✅ Done | `707eb37` |
| 53 — Adventure Document Import/Export | ✅ Done | `536bd3e` |
| 54 — Canvas Viewport Read & Digital TableTops TV2GM Parity | ✅ Done | `51a93a7` |

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

Done (`4b15288`).

Phase 16 added embedded Combatant create/remove only; there's no way to
change a combatant's fields without deleting and re-adding it.

- `PUT /api/combats/:id/combatants/:combatantId` wrapping the embedded
  Combatant's own `update()` (routes through its parent `Combat`, same
  pattern as every embedded document since Phase 10) — `defeated`, `hidden`,
  `initiative`, name override, etc.
- MCP: `foundry_update_combatant`.
- No new ambient declaration was needed — an embedded Combatant is already a
  `FoundryDocument`, confirming the plan's prediction.

## Phase 40 — Combat Turn/Round Navigation

Done (`4b15288`).

Phase 16 added `start`/`next-turn`/`next-round`/`end` only; there's no way to
step backward.

- `POST /api/combats/:id/previous-turn`, `POST /api/combats/:id/previous-
  round` wrapping `Combat#previousTurn()`/`Combat#previousRound()`.
- MCP: `foundry_combat_previous_turn`, `foundry_combat_previous_round`.
- **Not live-verified**: Foundry core's source shows neither method opening a
  dialog the way Phase 37 found `endCombat()` did, so they're implemented as
  direct pass-throughs like `next-turn`/`next-round`. Unlike Phase 37's
  findings this wasn't confirmed against a running world — flag for the next
  live smoke-test pass.

## Phase 41 — Scene Regions

Done (`cb78b30`).

`RegionDocument` (Foundry v11+ Scene Regions) is a real embedded placeable
type that sits alongside the six Phase 22 already covers (Drawing, Note,
AmbientLight, AmbientSound, Wall, MeasuredTemplate) but was never added —
likely because it postdates when Phase 22 was scoped.

- Added `"Region"` as a seventh `documentType` to the Phase 22
  `makeEmbeddedPlaceableEndpoints()` factory (`server/src/endpoints/
  placeables.ts`) — needed no new server-side code beyond the one extra
  factory call, confirming the plan's prediction.
- No explicit version-guard code was added: `Scene#getEmbeddedCollection()`
  already throws on an unsupported embedded name, and the command
  dispatcher (`module/src/command-registry.ts`) already turns any handler
  exception into a clean `HANDLER_ERROR` bridge response — an older core
  without Regions degrades to a clear error automatically, not a crash.
- MCP tools mirrored via the factory (`foundry_list_scene_regions`, etc.),
  same naming convention as the other six placeable types.
- Not live-verified against a real Foundry world with Scene Regions enabled
  (same caveat as Phase 40 — flag for the next live smoke-test pass).

## Phase 42 — UI Notifications

Done (`9b6a038`).

No way currently to push a message to a connected client's screen outside of
chat — useful for an agent that wants to surface a status update to the GM
without polluting the chat log.

- `POST /api/notify {message, type?: 'info'|'warning'|'error', target?:
  'caller'|'all'}` wrapping `ui.notifications.notify(message, type)`.
  `ui.notifications.notify()` is client-local only — it does **not**
  propagate to other connected clients the way a document write does — so
  `target: 'all'` (default `'caller'`, matching the historical single-client
  behavior) relays through the same `game.socket.emit()` broadcast mechanism
  built in Phase 47, letting a notification actually reach players, not just
  the GM's own screen. Reuses Phase 47's socket plumbing rather than
  inventing a second one, as planned.
- **Deviation from this section's original wording**: the notification level
  is `'info'|'warning'|'error'`, not `'info'|'warn'|'error'` — Foundry's real
  `Notifications#notify(message, type)` has never accepted `'warn'`. Caught
  before coding by checking Foundry's documented core API rather than at a
  live smoke-test (unlike Phase 37's dnd5e findings), since this part of core
  is old and stable.
- MCP: `foundry_notify`.
- New ambient declaration: a minimal `ui.notifications` surface in
  `foundry-globals.d.ts` (this project's first ambient `ui.*` declaration).
- **Bundled refactor**: Phase 47's `CANVAS_PUSH_VIEW_SOCKET_EVENT` constant
  (`shared/src/placeables.ts`) was renamed to the domain-neutral
  `MODULE_SOCKET_EVENT` and moved to a new `shared/src/socket.ts`, since it's
  now this phase's broadcast channel too, not just Phase 47's. The receive
  side (`module/src/socket.ts`) was generalized from
  `registerCanvasBroadcastListener()` to `registerModuleSocketListener()`,
  which now discriminates each inbound message by its own `type` field
  (`"pushView"` vs. `"notify"`) and dispatches accordingly — one shared
  `game.socket` event carrying multiple broadcast kinds, rather than
  registering a second event. No behavior change to Phase 47's own
  push-view path, confirmed by the existing placeables tests still passing
  unchanged.

## Phase 43 — World Time / Calendar

Done (`cb78b30`).

`game.time.worldTime` (and advancing it) is untouched by any existing phase,
despite being relevant to rest mechanics and any calendar-aware system.

- `GET /api/world-time` wrapping `game.time.worldTime`.
- `POST /api/world-time/advance {seconds}` wrapping `Game#time.advance()`
  (GM-only, same `requireGM()` convention as Phase 7/25).
- MCP: `foundry_get_world_time`, `foundry_advance_world_time`.
- **Not live-verified**: implemented against the documented core API shape,
  same caveat as Phase 40. Whether `game.time` exposes a richer calendar API
  in later V12+ builds worth a follow-up phase was not checked against a
  running world — flag for the next live smoke-test pass, alongside Phase
  40/41's same caveat.

## Phase 44 — Token Targeting

Done (`cb78b30`).

Phase 25 explicitly built canvas *selection* (`canvas.tokens.controlled`)
and skipped *targeting* (`user.targets`) — but targeting is what most
systems' attack/save rolls actually key off.

- `GET /api/canvas/targets` wrapping `game.user.targets` (mirrors Phase 25's
  selection-read shape, including its "no active canvas" error precedent).
- `POST /api/canvas/targets {tokenIds, additive?}` wrapping
  `Token#setTarget()` per id — clears existing targets first (each with
  `releaseOthers: false`, called manually rather than relying on
  `setTarget()`'s own default `releaseOthers: true`, which would otherwise
  clear on every call in a multi-target loop instead of just once up front)
  unless `additive: true` is passed.
- MCP: `foundry_get_targets`, `foundry_set_targets`.
- New ambient declarations: `FoundryUser#targets` (`Set<FoundryPlaceable>`),
  `FoundryPlaceable#setTarget()`, `canvas.tokens.placeables`.

## Phase 45 — Chat Message Update/Delete

Done (`cb78b30`).

Phase 14 deliberately scoped `ChatMessage` to create + bounded recent-read,
not full CRUD; there was no way to edit or retract a message.

- `PUT/DELETE /api/chat/:id` — reuses Phase 8's already-generic
  `DOCUMENT_COMMANDS.UPDATE`/`DELETE` with `documentType: "ChatMessage"`
  baked in directly (`server/src/endpoints/chat.ts`), confirming it "just
  works": no module-side code at all was needed, since those two commands'
  handlers (`module/src/commands/documents.ts`) are already fully generic
  across document types. The full `makeDocumentEndpoints()` factory itself
  was deliberately *not* called here — it would also regenerate list/create
  descriptors colliding with the hand-rolled `/chat` route's different
  request/response shapes at the same path.
- MCP: `foundry_update_chat_message`, `foundry_delete_chat_message`.

## Phase 46 — Fog of War Reset

Done (`cb78b30`).

No way previously existed to clear a scene's explored fog-of-war.

- `POST /api/scenes/:id/reset-fog` wrapping `Scene#resetFog()`.
- MCP: `foundry_reset_scene_fog`.
- Operates on any scene by id, not just the currently-viewed one: Foundry's
  own `resetFog()` resolves purely off the target Scene document's own id
  (it clears that scene's FogExploration records), so no "must be active
  scene" restriction was needed — same shape as `ACTIVATE`/`GET_DIMENSIONS`.
- New ambient declaration: `FoundryScene#resetFog()`.

## Phase 47 — Broadcast Camera View to All Players

Done (`cb78b30`).

Found during a DM-workflow audit (functions an AI running a live session
needs): Phase 22's camera pan/zoom (`canvas.animatePan()`) only moves the
camera of whichever single client the bridge happens to be connected to
(`server/src/bridge/gateway.ts` intentionally supports exactly one active
bridge connection). It does not, and structurally cannot, reach other
connected players — unlike document writes (scene activate, HP changes,
token moves, chat messages), which already propagate to every client for
free via Foundry's own document-sync socket. Pan/zoom and Phase 42's
`ui.notifications.notify()` are the two client-local exceptions to that.

- `POST /api/canvas/push-view {x, y, scale}` — the GM's connected module
  instance relays via `game.socket.emit()` on a module-scoped socket event
  (`module.foundry-local-api`), *and* pans directly on its own client too:
  `game.socket.emit()` is relayed by Foundry's server to every *other*
  connected client but never back to the sender itself, so skipping the
  direct local call would leave the GM's own camera behind.
- Every client that has this module enabled — including players, who never
  open a bridge connection at all — registers a listener for that socket
  event and calls `canvas.animatePan()` locally on receipt. This lives in a
  new file, `module/src/socket.ts` (deliberately outside `commands/`, same
  reasoning as `hooks.ts`: it reacts to Foundry's own multiplayer socket,
  not an inbound bridge request), registered unconditionally from
  `module/src/index.ts`'s `ready` hook — it runs regardless of whether that
  client's own bridge WS ever connects. No change to the "one active bridge
  connection" design (Phase 3) was needed: this rides Foundry's own
  always-on multiplayer socket, not the bridge.
- MCP: `foundry_push_view_to_players`.
- New ambient declaration: `game.socket` (`emit()`/`on()`).
- Phase 42 (next up) can reuse the same `game.socket` plumbing for its
  `target: 'all'` notification broadcast.

## Phase 48 — Playlist playAll/stopAll

Done (`9232324`).

Phase 17 deliberately narrowed "play/stop/pause sound" to a single embedded
`PlaylistSound`; there was no way to start/stop every sound in a playlist at
once (Foundry's own playlist sidebar's own "play all" control).

- `POST /api/playlists/:id/play-all` / `POST /api/playlists/:id/stop-all`
  wrapping `Playlist#playAll()`/`Playlist#stopAll()` — confirmed via the live
  Foundry API docs (`foundryvtt.com/api/classes/foundry.documents.Playlist
  .html`) rather than a running world, same "check core API docs before
  coding" shortcut Phase 42 used for `ui.notifications.notify()`.
- MCP: `foundry_play_all_playlist_sounds`, `foundry_stop_all_playlist_sounds`.
- New ambient declarations: `FoundryPlaylist#playAll()`/`#stopAll()`.
- **Deviation from the backlog wording**: "global audio volume (`game.audio`)"
  was deliberately left out — it isn't a `Playlist` document method at all,
  it's client settings (`core.globalPlaylistVolume`/`globalAmbientVolume`/
  `globalInterfaceVolume`), already reachable through Phase 7's generic
  `GET/PUT /api/settings/:namespace/:key` — same "already reachable through
  the generic settings endpoint" reasoning the backlog's own module
  enable/disable entry (below) already used, so a dedicated endpoint would
  just be a redundant wrapper.

## Phase 49 — Cards Pass/Deal

Done (`9232324`).

Phase 18 deliberately narrowed "card pile operations" to draw/shuffle/reset;
there was no way to move specific cards to one other stack (`pass`) or
distribute cards to several destination stacks at once (`deal`) — both real
`Cards` document methods per the live Foundry API docs
(`foundryvtt.com/api/classes/foundry.documents.Cards.html`).

- `POST /api/cards/:id/pass {toId, cardIds}` wrapping `Cards#pass(to, ids)` —
  returns the moved Card documents (same "return the created/moved child"
  convention as `draw`).
- `POST /api/cards/:id/deal {toIds, number?}` wrapping
  `Cards#deal(to[], number)` — returns the source stack's own `toObject()`
  (same convention as `shuffle`/`reset`), since the interesting state change
  for a multi-destination deal is what's left behind in the source, not any
  one destination.
- MCP: `foundry_pass_cards`, `foundry_deal_cards`.
- New ambient declarations: `FoundryCardsStack#pass()`/`#deal()`.
- Not live-verified against a running world (same caveat as Phases 40/41/43
  — flag for the next live smoke-test pass); confirmed against documented
  core API shape only.

## Phase 50 — Active GM Lookup

Done (`9232324`).

`game.users.activeGM` ("one User who is an active Gamemaster (non-assistant
if possible), or null" per Foundry's own doc comment) was never exposed —
useful for an agent-driven workflow that should run once, on a single
authoritative connected client, rather than once per connected GM.

- `GET /api/users/active-gm` wrapping `game.users.activeGM`, returning
  `{userId: string | null}`.
- Registered **ahead of** the existing `GET /api/users/:userId` in
  `userEndpointDescriptors` — Express matches routes in registration order,
  so the literal `active-gm` path segment would otherwise be swallowed by the
  `:userId` param route (confirmed by a test asserting the bridge command
  actually dispatched is `userGetActiveGm`, not `userGet` with
  `userId: "active-gm"`).
- MCP: `foundry_get_active_gm`.
- New ambient declaration: `FoundryUsers` (extends `Map<string, FoundryUser>`
  with `activeGM: FoundryUser | null`), replacing `game.users`' previous bare
  `Map<string, FoundryUser>` type — every existing `game.users.get()`/
  `.values()` call site is unaffected since `Map`'s own methods are still
  present.
- Not live-verified (same caveat as Phase 49).

## Phase 51 — Compendium Pack Lifecycle

Done.

Promoted from the Backlog's "Compendium pack lifecycle" entry: Phase 20
covers CRUD on entries *within* an existing compendium pack, but never added
lifecycle operations on the pack itself — creating, deleting, or duplicating
a pack (`CompendiumCollection.createCompendium()`) wasn't covered.

- `POST /api/packs {type, label, name?}` wrapping the **static**
  `CompendiumCollection.createCompendium()` — not reachable off any pack
  instance or off `game.packs`, unlike every other Phase 20 pack operation.
  GM-only per Foundry's own docs ("may only be performed... by a
  Gamemaster"). Fields beyond `type`/`label` are read defensively per the
  Phase 34 convention and passed through mostly as-is, rather than
  over-specifying the zod schema against an API that isn't live-verified.
- `DELETE /api/packs/:packId` wrapping the **instance** method
  `pack.deleteCompendium()` — GM-only, same convention. Unlike Phase 37's
  `Combat#endCombat()` finding, Foundry's docs describe no confirmation
  dialog for `deleteCompendium()`, so this is a direct pass-through, not a
  workaround. Flagged `destructiveHint: true` (paired with a plain-language
  warning in the tool's own `description`, per this project's
  annotations-are-advisory-only convention) since it deletes the pack and
  every entry inside it, permanently.
- `POST /api/packs/:packId/duplicate {label?}` wrapping the **instance**
  method `pack.duplicateCompendium(label?)` — GM-only for consistency with
  the other two (Foundry's docs don't explicitly restrict this one to GMs,
  but it's the same class of world-structural write).
- MCP: `foundry_create_pack`, `foundry_delete_pack`, `foundry_duplicate_pack`.
- New route shapes confirmed non-colliding with Phase 20's existing
  `/packs/:packId/entries[/...]` routes before adding (`POST /packs` and
  `DELETE /packs/:packId` were never previously registered at all) — see
  `server/src/endpoints/packs.test.ts`'s explicit non-collision test.
- New ambient declarations: a standalone top-level `CompendiumCollection`
  class binding (its static `createCompendium()`), plus
  `deleteCompendium()`/`duplicateCompendium()` added to the existing
  `FoundryCompendiumCollection` interface.
- First GM-gating (`requireGM()`) added to `module/src/commands/packs.ts` —
  Phase 20's entry-level CRUD predates the Phase 7/25 GM-gating convention
  and is correctly left ungated (pack *entries* aren't restricted the way
  the pack lifecycle itself is per Foundry's own docs).
- **Not live-verified**: implemented against the documented core API shape
  only (`foundryvtt.com/api` `CompendiumCollection`/`Cards`-style class
  docs), same caveat as Phases 40/41/43/49/50 — flag for the next live
  smoke-test pass.

---

## Phase 52 — Digital TableTops Integration (Battlemap Control)

Done (`707eb37`).

Second `kind: "module"` integration (dnd5e is `kind: "system"`) — the first
real exercise of that half of the Phase 32 framework. Target:
`digital-tabletops`, installed side-by-side with this repo under
`Data/modules/`, whose job is driving a physical TV/touch-frame battlemap
display for in-person sessions. A special Foundry user named "TV" (a second
browser/screen) *is* the display; the GM's client controls it purely by
broadcasting on Foundry's own multiplayer socket (`game.socket`, channel
`"module.digital-tabletops"`) — the exact same primitive Phase 47's
`canvasPushView` already proved out (`game.socket.emit(event, data)`, typed
generically in `module/src/types/foundry-globals.d.ts`), just a third-party
channel name/payload shape instead of this project's own
`MODULE_SOCKET_EVENT`. Read directly from `dtt.js` source (a single small
file) rather than third-party docs.

- `detect: (_activeSystemId, activeModuleIds) =>
  activeModuleIds.includes("digital-tabletops")`. No `minVersion`/
  `maxVersion` — implemented against the one shipped version (1.0.6) read
  directly from source, same no-version-pin precedent as dnd5e.
- **Two of the module's four actions need no new code at all.** `hideUI`,
  `lockPan`, `display-width`, and `port-number` are plain Foundry world
  settings (`game.settings.register("digital-tabletops", ...)`) whose own
  `onChange` handlers do the real socket emit — already fully reachable via
  the existing generic `GET/PUT /api/settings/digital-tabletops/:key`
  endpoints (Phase 7), synced to every connected client (including the TV
  user) by Foundry's own settings-sync. No integration-specific wrapper
  needed; just document the exact namespace/keys in this integration's
  endpoint descriptions/README so a caller doesn't have to go read `dtt.js`
  itself to find them.
- New commands (`shared/src/digital-tabletops.ts`,
  `module/src/commands/digital-tabletops.ts`,
  `server/src/integrations/digital-tabletops/{index,endpoints}.ts`):
  - `dtt_pan_battlemap` — `POST /digital-tabletops/pan`
    `{x, y, targetWidth?, targetHeight?}` →
    `game.socket.emit("module.digital-tabletops", {action: "panCanvas", x, y, targetWidth, targetHeight})`.
    The general "point the battlemap at this region" primitive — covers the
    *effect* of the module's own `panTV` (click-to-location) and `TV2GM`
    (mirror GM view) buttons, generalized to explicit coordinates a caller
    computes itself (e.g. from a token's position or a scene's dimensions)
    rather than reading a live DOM viewport.
  - `dtt_scale_battlemap_to_physical` — `POST /digital-tabletops/scale-to-physical`,
    no input → emits `{action: "panCanvas", scale: "physical"}` (1 grid = 1
    real-world inch, per the configured `display-width` setting).
  - `dtt_get_status` — `GET /digital-tabletops/status` → convenience
    composite read: module active, whether a user named "TV"
    (case-insensitive, matching `dtt.js`'s own check) exists and is
    currently online (`FoundryUser#active`), plus the four current settings
    values — so a caller can confirm a battlemap display is actually
    connected before driving it, without hand-composing four settings reads
    plus a users-list-and-filter. Mirrors dnd5e's `dnd5e_get_config`
    precedent: a pure-discovery tool that isn't new capability so much as
    reduced friction for this integration's actual use case.
- **Deliberately not built**: a literal `TV2GM` equivalent ("mirror
  whatever the GM's own browser is currently looking at"). That button reads
  the connected client's *live DOM* canvas viewport
  (`canvas.canvasCoordinatesFromClient`/`canvas.stage.scale`) at the moment
  it's clicked — there is no existing "get current camera position" read
  endpoint in this codebase to source that from headlessly (Phase 22/47 only
  ever *set* the camera, never read it back), and faking it would silently
  assume the bridge's connected client is the GM's own real screen, which
  isn't guaranteed. If a real need shows up later, add a
  `canvas_get_viewport` **core** endpoint first (its own phase, core domain,
  not integration-specific — other callers would want it too), then revisit.
- MCP: `dtt_pan_battlemap`, `dtt_scale_battlemap_to_physical`,
  `dtt_get_status`.
- `module.json`: one `relationships.recommends` entry (`type: "module"`) and
  one matching `flags["foundry-local-api"].optionalIntegrations` entry,
  `"implemented": false` until this phase actually lands (Phase 33
  convention) — then flip to `true`/remove the key.
- Test: `server/src/integrations/digital-tabletops/endpoints.test.ts`
  following the dnd5e harness (bare Express app + fake `FoundryClient`, one
  happy-path test per route).
- **Not live-verified**: no live Foundry + digital-tabletops session with a
  real or simulated "TV" client was available — flag for a live smoke-test
  pass alongside the other not-yet-verified phases.
- **Deviation**: `dtt_pan_battlemap`/`dtt_scale_battlemap_to_physical` return
  a small `DttAckResult { acknowledged: true }` rather than `void` — no
  `EndpointDescriptor<..., void>` precedent exists anywhere in this codebase,
  and the REST path's `res.json(result)` call is untested against
  `undefined`. Same "small ack object for a broadcast action" shape Phase
  42's `NotifyResult` already established for its own fire-and-forget
  `game.socket.emit()` action.
- `module.json`'s `optionalIntegrations` entry landed with `"implemented":
  true` directly (not `false` then flipped) since the code was registered in
  the same session/commit.

---

## Phase 53 — Adventure Document Import/Export

Done.

Promoted from the Backlog's "Adventure document import/export" entry on
request.

`Adventure` is compendium-only in Foundry (v10+) — no `game.collections`
entry, no top-level world collection, unlike Actor/Item/Scene/etc. It only
ever lives inside an Adventure-type compendium pack, reached the same way
Phase 20/51 reach any pack entry (`game.packs` → `pack.getDocument(id)`).
Its content is a fixed set of embedded-data arrays covering every other
document type this project already drives: `actors`, `combats`, `items`,
`journal`, `scenes`, `tables`, `macros`, `cards`, `playlists`, `folders`
(`Adventure.contentFields`).

- **Import** wraps the instance method `adventure.import()` — a bulk
  operation distinct from Phase 20's existing `foundry_import_pack_entry`
  (`worldCollection.importFromCompendium()`), which only ever pulls a
  *single* document of the pack's own type into its matching world
  collection. An Adventure entry has no single matching world collection —
  importing it creates/updates documents across *many* world collections in
  one call. New command `ADVENTURE_COMMANDS.IMPORT` →
  `POST /api/packs/:packId/adventures/:entryId/import`, tool
  `foundry_import_adventure`. Handler: `requirePack(packId)` →
  `requirePackEntry(pack, entryId)` → cast to a new ambient
  `FoundryAdventureDocument` (adds only `import(options?: {dialog?: boolean})
  : Promise<Record<string, unknown>>` to the base `FoundryDocument`
  interface) → call with `{dialog: false}` to skip Foundry's own UI
  confirmation dialog (this is a headless API caller, not a browser click).
  GM-gated (`requireGM`, per the Phase 51 precedent for world-structural
  writes) since it creates/updates arbitrary world content.
  - **Read defensively** (Phase 34 convention): the exact
    `AdventureImportResult` field shape isn't live-verified against a
    running world, so the return type is a plain `Record<string, unknown>`
    pass-through of whatever `.import()` resolves to, not a hand-specified
    interface.
  - **Deviation**: calling `.import({dialog: false})` (rather than the
    dialog-prompting default) is an inferred parameter, not confirmed
    against live Foundry source — flag alongside the phase's own
    not-live-verified note below.
- **Export** has no dedicated Foundry API — there's no `Adventure.create()`
  or `toCompendium()`-equivalent; building one is a UI-only drag-and-drop
  workflow in the real app. The closest existing coverage,
  `foundry_create_pack_entry` (`POST /packs/:packId/entries {data}`),
  *technically* already lets a caller create an Adventure entry, but only if
  they first fetch and hand-assemble every included document's full data
  themselves. The actual friction worth removing is that assembly step, so
  this phase adds one convenience command that takes world-document *ids*
  per content type instead of pre-fetched blobs: `ADVENTURE_COMMANDS.EXPORT`
  → `POST /api/packs/:packId/adventures
  {packId, name, img?, caption?, description?, actorIds?, itemIds?,
  sceneIds?, journalIds?, macroIds?, tableIds?, cardsIds?, playlistIds?,
  folderIds?, combatIds?}`, tool `foundry_export_adventure`. Handler:
  `requireGM`, then for each populated `*Ids` field look up
  `game.collections.get(<matching Foundry type>)?.get(id)` (throwing on a
  missing id, same not-found convention as `requirePackEntry`), `.toObject()`
  each found document, and assemble them under the matching
  `Adventure.contentFields` key (`journalIds` → `journal`, `tableIds` →
  `tables`, `cardsIds` → `cards`, everything else `<x>Ids` → `<x>s`) —
  documented as an explicit id→type→content-field table in
  `module/src/commands/adventures.ts`, not inferred generically from string
  manipulation. Then `pack.documentClass.create(data, {pack:
  pack.metadata.id})`, same creation call Phase 20's `CREATE_ENTRY` already
  uses. Returns the created Adventure's full `.toObject()` (`DocumentData`),
  matching `foundry_create_pack_entry`'s existing return shape.
- New files (own domain, not folded into `packs.ts`, since this is
  content-assembly + a bulk-mutation verb rather than pack-entry CRUD):
  `shared/src/adventures.ts`, `server/src/endpoints/adventures.ts`,
  `module/src/commands/adventures.ts`,
  `server/src/endpoints/adventures.test.ts`. `requirePack()`/
  `requirePackEntry()`/`requireGM()` are duplicated locally in
  `adventures.ts` rather than imported from `packs.ts` — matching this
  project's existing precedent of a small per-file `requireGM()` in
  `packs.ts`/`permissions.ts`/`users.ts`/`world-time.ts` rather than a
  shared helpers module.
- Route paths (`/packs/:packId/adventures[...]`) confirmed non-colliding
  with Phase 20/51's existing `/packs/:packId/entries[...]` and
  `/packs/:packId/duplicate` routes before adding — new path segment, same
  check Phase 51 did.
- MCP: `foundry_export_adventure`, `foundry_import_adventure`.
- No `module.json` changes — core domain functionality, not an optional
  integration (Phase 32/33 convention only applies to system/module-specific
  integrations).
- **Not live-verified**: implemented against general knowledge of Foundry
  v10+'s `Adventure` document class (introduced v10; `contentFields`,
  `import()`/`prepareImport()`/`importContent()`) rather than a fetched
  `foundryvtt.com/api` page or a running world — flag for the next live
  smoke-test pass, same caveat as Phases 40/41/43/49/50/51/52.

---

## Phase 54 — Canvas Viewport Read & Digital TableTops TV2GM Parity

Done.

Promoted (user request: "complete control of the digital tabletop module")
from the specific gap Phase 52's own write-up flagged and deferred: *"a
literal `TV2GM` equivalent (mirror whatever the GM's own browser is currently
looking at)... If a real need shows up later, add a `canvas_get_viewport`
core endpoint first (its own phase, core domain, not integration-specific —
other callers would want it too), then revisit."* That need has now shown
up — this phase does exactly that, plus the integration action it unblocks.

Re-read `Data/modules/digital-tabletops/dtt.js` (v1.0.6) directly (same
no-guessing precedent as Phase 52). Its `TV2GM` scene-control button (lines
196-213) is the one remaining un-parity'd action:

```js
const scale = canvas.stage.scale.x;
const { x, y } = canvas.canvasCoordinatesFromClient({
  x: 0.5 * canvas.app.screen.width, y: 0.5 * canvas.app.screen.height,
});
game.socket.emit("module.digital-tabletops", {
  action: "panCanvas", x, y,
  targetWidth: canvas.app.screen.width / scale,
  targetHeight: canvas.app.screen.height / scale,
});
```

Everything else in the module's own GM toolbar (`hideUI`, `lockPan`,
`scaleTV`, `panTV`) already has API parity as of Phase 52 — this phase closes
the last gap, giving genuinely complete remote-control coverage of the
module's own UI.

- **Core (`shared/src/placeables.ts`, `server/src/endpoints/placeables.ts`,
  `module/src/commands/placeables.ts`):** new `CANVAS_COMMANDS.GET_VIEWPORT`
  (`"canvasGetViewport"`). `GET /api/canvas/viewport` → `foundry_get_canvas_viewport`,
  no input. Module-side handler is a pure read, no `animatePan()` call:
  `{ x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.scale }`
  — reusing `CanvasPanResult` as-is (Phase 22's `PAN` handler already computes
  and returns this exact shape after panning; this just reads it without the
  side effect), same "no active canvas" error as `PAN`/`PUSH_VIEW` when
  `!canvas`.
- **Integration (`shared/src/digital-tabletops.ts`,
  `server/src/integrations/digital-tabletops/endpoints.ts`,
  `module/src/commands/digital-tabletops.ts`):** new `DTT_COMMANDS.MIRROR_GM_VIEW`
  (`"dttMirrorGmView"`). `POST /digital-tabletops/mirror-gm-view` →
  `dtt_mirror_gm_view`, no input, returns `DttAckResult` (same
  fire-and-forget-broadcast shape as `dtt_pan_battlemap`/
  `dtt_scale_battlemap_to_physical`). The module-side handler replicates
  `TV2GM`'s exact math above inline (screen-center `canvasCoordinatesFromClient`
  + scale-derived target width/height) rather than round-tripping through the
  new core `canvasGetViewport` command internally — both handlers execute in
  the same client process, and there's no precedent in this codebase for one
  command handler invoking another's REST route internally; the core endpoint
  exists for external callers (e.g. "where is the GM currently looking?"
  before deciding where to pan), the integration handler just reads the same
  live canvas state directly, same as `dtt.js`'s own button does.
- MCP: `foundry_get_canvas_viewport`, `dtt_mirror_gm_view`.
- No `module.json` changes — reuses the existing `digital-tabletops`
  `optionalIntegrations` entry from Phase 52 (already `"implemented": true`);
  this only adds an action to an integration already declared.
- Same caveat Phase 52 already recorded for every action in this
  integration: assumes the bridge's connected client *is* the GM's own real
  screen, which isn't guaranteed by anything in this codebase — document in
  the tool description, don't attempt to verify it.
- Tests: `server/src/endpoints/placeables.test.ts` (new case for
  `GET /api/canvas/viewport`, mirroring the existing `canvasPan`/
  `canvasPushView` cases) and
  `server/src/integrations/digital-tabletops/endpoints.test.ts` (new case for
  `POST /digital-tabletops/mirror-gm-view`, mirroring
  `scale-to-physical`'s no-input/ack-result shape).
- **Deviation**: `module/src/types/foundry-globals.d.ts`'s ambient `canvas`
  type needed two distinct scale fields, not one — the pre-existing
  top-level `canvas.scale: number` convenience field (`PAN`/`GET_VIEWPORT`
  use this) is a different value from PIXI's own `canvas.stage.scale.x`
  (`dtt.js`'s `TV2GM` reads this one specifically) — both now coexist on the
  ambient type since Foundry itself exposes both.
- **Not live-verified**: same standing caveat as the rest of the
  digital-tabletops integration (Phase 52) — no live Foundry + digital-tabletops
  session with a real or simulated "TV" client was available.

---

## Backlog — noted, not scheduled

Lower-priority or more niche gaps surfaced during the same audit. Promote
any of these to a numbered phase on request.

- **Module enable/disable** via `core.moduleConfiguration` — technically
  reachable through the existing generic settings endpoint (Phase 7), but
  requires a world reload to take effect and wasn't built as a dedicated,
  documented action.
- **World shutdown / return-to-setup.** Administrative and destructive
  (drops every connected player); probably should **not** be exposed via
  this API at all rather than being a scheduling gap. Flagging for an
  explicit decision, not implementation.
- **Launching Foundry / logging into a world / the Setup screen.** These all
  happen *before* any world is running and before this module's code loads
  at all — the module only activates inside an already-running world, in an
  already-authenticated browser tab. Not a phase gap: it's a different
  automation surface (driving the actual browser/Electron UI), out of scope
  for this REST/MCP server entirely.

---

## Notes for execution

- Each domain phase should start by inspecting the *live* Foundry client
  console for the exact current API shape before coding against it —
  Foundry's Document API is stable in outline but field-level details shift
  between versions (Phase 37 found this the hard way for dnd5e's roll
  methods).
- Every phase = endpoint(s) + matching MCP tool(s) + test — never land a
  REST route without its MCP counterpart in the same phase.
- Phases 39–47 are mutually independent domain additions (same shape as the
  original Phases 22–28 "Execution Batching"), grouped below into tracks that
  touch disjoint files and so can genuinely run in parallel (e.g. as separate
  engineers or separate agent sessions) without stepping on each other:

  - **Track A — Combat** (`combats.ts` + `shared/src/combats.ts`): Phase 39
    → Phase 40, **sequential** — both touch the same combat-domain files, so
    don't work them fully in parallel against each other. **Done** — both
    landed together in one pass since they're small and share a file anyway.
  - **Track B — Canvas broadcast** (`placeables.ts` server+module +
    `foundry-globals.d.ts` ambient `game.socket` declaration): Phase 47 →
    Phase 42, **sequential** — 42's `target: 'all'` notification option
    reuses 47's socket-broadcast plumbing, so 47 must land first. **Both
    done** (`cb78b30`, Phase 42 in the following commit) — landing Phase 42
    also renamed the shared socket-event constant and generalized the
    module-side listener (see Phase 42's write-up above), touching
    `shared/src/placeables.ts`/`module/src/socket.ts` alongside the new
    `notifications.ts` files.
  - **Track C — Scene Regions** (`placeables.ts`): Phase 41 alone. **Done**
    (`cb78b30`) — landed in the same batch as Track B; both were pure
    additive descriptor/factory-call insertions in unrelated parts of the
    file, a trivial merge as predicted, not a logical conflict.
  - **Track D — World Time** (`world-time.ts`, new file): Phase 43 alone.
    **Done** (`cb78b30`).
  - **Track E — Token Targeting** (`users.ts`, mirrors Phase 25's selection
    endpoint): Phase 44 alone. **Done** (`cb78b30`).
  - **Track F — Chat Message CRUD** (`chat.ts`): Phase 45 alone. **Done**
    (`cb78b30`).
  - **Track G — Fog of War** (`scenes.ts`): Phase 46 alone. **Done**
    (`cb78b30`).

  Tracks A, C, D, E, F, G plus Phase 47 of Track B all landed together in one
  batch (`cb78b30`) since none of them touch each other's files. Phase 42
  (the second half of Track B) landed in a follow-up commit — see its
  write-up above. **All Phases 38–47 are now done; no phase remains open.**
