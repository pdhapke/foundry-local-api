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
| 37 — Live Smoke-Test Pass | ✅ Done | _pending_ |

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
- Phase 7 hit the first descriptor with a non-`void` input (`GetSettingInput`/
  `SetSettingInput`), which broke the bare `EndpointDescriptor[]` type used
  for heterogeneous descriptor collections (`allEndpointDescriptors`, the
  `mountRestEndpoints`/`registerMcpTools` params) under
  `exactOptionalPropertyTypes`. Fixed by adding `AnyEndpointDescriptor =
  EndpointDescriptor<any, any>` (`server/src/endpoints/types.ts`) as the
  explicit type-erased collection type — every later phase with a
  non-void-input descriptor reuses this rather than re-deriving it.
- Phase 7 also generalized `validateQuery`/`validateBody`
  (`server/src/middleware/validate.ts`) to validate `{...req.params,
  ...req.query|body}` instead of just `req.query`/`req.body`. This is what
  lets a route with path params (`/settings/:namespace/:key`, the first of
  its kind) share one flat `inputSchema` between its REST route and its MCP
  tool's argument bag, and applies automatically to every later phase's
  path-param routes.
- Phase 7's GM-only gating for world-scope settings is enforced module-side
  (`module/src/commands/settings.ts`), not on the server: the server has no
  concept of "which Foundry user issued this request" beyond the single
  static API key (Phase 4), whereas the connected module always knows both
  the registered setting's `scope` and `game.user.isGM`. Same untested-
  against-a-live-instance caveat as Phase 6 applies here.
- Phase 8 registers its five module-side commands (`documentList/Get/Create/
  Update/Delete`, `module/src/commands/documents.ts`) once, generically,
  rather than once per document type — `documentType` travels in the command
  payload and selects `game.collections.get(documentType)` /
  `CONFIG[documentType].documentClass` at call time. The server-side
  genericity lives in `makeDocumentEndpoints()`
  (`server/src/endpoints/documents.ts`), which takes a `documentType` plus
  explicit REST/MCP naming (`routeBase`, `toolSingular`, `toolPlural`) and
  returns five descriptors with `documentType` closed over. Naming is passed
  in explicitly rather than derived (e.g. pluralizing `JournalEntry` to
  `journal-entries`/`journal_entries`) — English pluralization is irregular
  enough (and Foundry's own document type names inconsistent enough) that
  auto-derivation would be more fragile than just asking each call site for
  the three strings it needs.
- Phase 8 extended `module/src/types/foundry-globals.d.ts` with `game.
  collections` and `CONFIG`, typed only down to the generic `FoundryDocument`/
  `FoundryDocumentClass` shape (`id`/`toObject()`/`update()`/`delete()` and
  static `create()`) this phase's handlers actually call — no per-document-
  type schema, consistent with Phase 6's decision to keep this file minimal
  and hand-rolled rather than adopt the community types package.
- Phase 8 was implemented and tested entirely against a mocked bridge client
  (`server/src/endpoints/documents.test.ts`) — no live Foundry instance was
  available, same caveat as Phases 6–7. The module-side generic command
  handlers build/typecheck cleanly but are unverified against a real
  `game.collections`/`CONFIG` object; flagged for a live smoke-test
  (starting with `JournalEntry` CRUD) whenever a Foundry instance is
  available.
- Phase 9 did not add any new commands for Actor CRUD itself — it calls the
  same generic `makeDocumentEndpoints()` factory Phase 8 built, with
  `documentType: "Actor"`, identical to how `JournalEntry` is wired. Only
  the two actor-specific extras (`GET /api/actors/:id/roll-data`,
  `GET /api/actors/:id/items`) needed new commands (`shared/src/actors.ts`'s
  `ACTOR_COMMANDS`), since `Actor#getRollData()` and the embedded `items`
  collection aren't part of the generic `Document` shape Phase 8 modeled.
- Phase 9 extended `module/src/types/foundry-globals.d.ts` with a minimal
  `FoundryActor` interface (`getRollData()` + `items: Map<string,
  FoundryDocument>`) layered on top of Phase 8's generic `FoundryDocument`,
  same hand-rolled/minimal approach as every earlier phase's globals.
- Phase 9's tests only cover the two new extras plus one smoke check that
  `actorEndpointDescriptors` mounts CRUD under `/api/actors` — full CRUD
  behavior is already proven generic by Phase 8's
  `makeDocumentEndpoints()` tests and isn't re-tested per document type.
  Same untested-against-a-live-instance caveat as Phases 6–8 applies to the
  module-side handlers (`module/src/commands/actors.ts`); flagged for a live
  smoke-test (roll data and items against a real system like dnd5e)
  whenever a Foundry instance is available.
- Phase 10 split cleanly into two halves per PLAN.md's own wording ("`/api/
  items` (world items) + embedded actor-item CRUD"): world-level Item CRUD
  again reuses the Phase 8 `makeDocumentEndpoints()` factory with
  `documentType: "Item"`, identical to JournalEntry/Actor; embedded
  actor-item CRUD (`/api/actors/:actorId/items[/:itemId]`) is hand-rolled in
  a new `shared/src/items.ts` (`EMBEDDED_ITEM_COMMANDS`) plus
  `server/src/endpoints/items.ts` and `module/src/commands/items.ts`, since
  an embedded item lives under its owning actor, not its own top-level
  document collection. The embedded item *list* endpoint already existed as
  `foundry_list_actor_items` (Phase 9) — Phase 10 only adds get/create/
  update/delete for a single embedded item.
- Phase 10 found that get/update/delete of a single embedded item need no
  new Foundry API surface: an embedded `Item` is itself a `FoundryDocument`,
  and Foundry routes `.update()`/`.delete()` on it through its parent actor
  automatically, so Phase 9's `FoundryActor#items` map plus Phase 8's
  existing `FoundryDocument` methods were already enough. Only embedded
  creation needed a new ambient declaration,
  `FoundryActor#createEmbeddedDocuments()`
  (`module/src/types/foundry-globals.d.ts`), since there's no "create" method
  on an item that doesn't exist yet.
- Phase 10's tests only cover the four embedded-item extras plus one smoke
  check that `itemEndpointDescriptors` mounts CRUD under `/api/items` — same
  rationale as Phase 9 (full generic CRUD is already proven by Phase 8's
  tests). Same untested-against-a-live-instance caveat as Phases 6–9 applies
  to the module-side handlers (`module/src/commands/items.ts`); flagged for
  a live smoke-test (embedded item create/update/delete against a real
  system like dnd5e) whenever a Foundry instance is available.
- Phase 11 followed the same split as Phases 9–10: world-level Scene CRUD
  reuses the Phase 8 `makeDocumentEndpoints()` factory with
  `documentType: "Scene"`, identical to JournalEntry/Actor/Item; the two
  scene-specific extras PLAN.md calls for (activate, grid/dimension info)
  are hand-rolled in `shared/src/scenes.ts` (`SCENE_COMMANDS`) plus
  `server/src/endpoints/scenes.ts` and `module/src/commands/scenes.ts`.
- Phase 11's dimensions endpoint reads Foundry's own computed `Scene#grid`
  (type/size/distance/units) and `Scene#dimensions` (`sceneWidth`/
  `sceneHeight`/`sceneX`/`sceneY`, the padded canvas rect) rather than
  hand-deriving pixel math from the raw `width`/`height`/`padding` fields —
  Foundry already computes and caches this, and re-deriving it independently
  would risk drifting from Foundry's own rounding/grid-snapping rules. This
  needed one new ambient declaration, `FoundryScene`
  (`module/src/types/foundry-globals.d.ts`), layered on `FoundryDocument`
  same as `FoundryActor` was in Phase 9.
- Phase 11's activate command returns the scene's updated `toObject()` (so a
  caller can confirm `active: true` without a follow-up `GET`) rather than a
  bare acknowledgement, consistent with how Phase 8's `update` descriptor
  already returns the post-update document.
- Phase 11's tests only cover the two scene-specific extras plus one smoke
  check that `sceneEndpointDescriptors` mounts CRUD under `/api/scenes` —
  same rationale as Phases 9–10. Same untested-against-a-live-instance
  caveat as Phases 6–10 applies to the module-side handlers
  (`module/src/commands/scenes.ts`); flagged for a live smoke-test
  (activation and dimensions against a real scene) whenever a Foundry
  instance is available.
- Phase 12 could not reuse the Phase 8 `makeDocumentEndpoints()` factory at
  all, unlike every document-CRUD phase since (JournalEntry/Actor/Item/
  Scene): a Token has no top-level entry in `game.collections` — it only
  ever exists embedded on a Scene. So all seven descriptors (list/get/
  create/update/delete plus move and visibility toggle) are hand-rolled in
  new `shared/src/tokens.ts`, `server/src/endpoints/tokens.ts`, and
  `module/src/commands/tokens.ts`, under `/api/scenes/:sceneId/tokens[/
  :tokenId]`, following the `<parent>Id`/`<child>Id` embedded-id shape Phase
  10 established for embedded items rather than inventing a new one.
- Phase 12's move and visibility-toggle extras are both thin wrappers over
  `TokenDocument#update()` (`{x, y}` and `{hidden}` respectively) rather than
  new Foundry API surface — consistent with Phase 10's finding that
  `update()`/`delete()` on an embedded document already route through its
  parent automatically. They're exposed as their own endpoints/tools (per
  PLAN.md's explicit "move, visibility toggle" wording) rather than folded
  into the generic update endpoint, since a natural-language MCP caller
  ("move this token to 400,250" / "hide this token") maps far more directly
  onto a dedicated tool than onto assembling a raw `changes` object.
- Phase 12 extended `module/src/types/foundry-globals.d.ts`'s `FoundryScene`
  with `tokens`/`createEmbeddedDocuments()`, the same shape Phase 9/10 gave
  `FoundryActor` for its embedded Items — no new ambient shape needed, since
  an embedded Token is itself a `FoundryDocument`.
- Phase 12's tests cover all seven descriptors directly (list/get/create/
  update/delete/move/visibility), since none of them are backed by an
  already-tested generic factory the way Phases 9–11's base CRUD was. Same
  untested-against-a-live-instance caveat as Phases 6–11 applies to the
  module-side handlers (`module/src/commands/tokens.ts`); flagged for a live
  smoke-test (embedded token CRUD, move, and visibility toggle against a
  real scene) whenever a Foundry instance is available.
- Phase 13 needed no new work for `JournalEntry` CRUD itself: Phase 8 already
  proved the `makeDocumentEndpoints()` factory against `JournalEntry` first
  (it's the "simplest document type" Phase 8's own plan text names), so
  `journalEntryEndpointDescriptors` (`server/src/endpoints/documents.ts`) was
  already registered under `/api/journal-entries` before this phase started.
  Phase 13's actual work is the second half of its plan text: embedded
  `JournalEntryPage` CRUD.
- Unlike embedded Items (Phase 10) but like embedded Tokens (Phase 12), a
  `JournalEntryPage` has no existing "list" command to fall back on — nothing
  prior needed to enumerate a journal entry's pages — so Phase 13 hand-rolls
  all five of list/get/create/update/delete in new `shared/src/
  journal-pages.ts` (`JOURNAL_PAGE_COMMANDS`), `server/src/endpoints/
  journal-pages.ts`, and `module/src/commands/journal-pages.ts`, under
  `/api/journal-entries/:journalEntryId/pages[/:pageId]`, following the same
  `<parent>Id`/`<child>Id` embedded-id shape as Phases 10/12.
- Phase 13 extended `module/src/types/foundry-globals.d.ts` with
  `FoundryJournalEntry` (`pages`/`createEmbeddedDocuments()`), the same shape
  Phase 9/10 gave `FoundryActor` for embedded Items and Phase 11/12 gave
  `FoundryScene` for embedded Tokens — no new ambient shape needed beyond
  that, since an embedded JournalEntryPage is itself a `FoundryDocument` and
  get/update/delete route through it automatically (same finding as Phase
  10).
- Phase 13's tests cover the five embedded-page descriptors directly, since
  none of them are backed by an already-tested generic factory (same
  rationale as Phase 12's tokens); `JournalEntry`'s own base CRUD is already
  covered by Phase 8's `makeDocumentEndpoints()` tests and isn't re-tested
  here. Same untested-against-a-live-instance caveat as Phases 6–12 applies
  to the module-side handlers (`module/src/commands/journal-pages.ts`);
  flagged for a live smoke-test (embedded page CRUD against a real journal
  entry, including page `type` variants like text/image/pdf/video) whenever a
  Foundry instance is available.
- Phase 14 split into two genuinely different halves. Dice rolling
  (`shared/src/rolls.ts`, `server/src/endpoints/rolls.ts`,
  `module/src/commands/rolls.ts`) is hand-rolled from scratch: Foundry's
  `Roll` class only exists client-side, so this is the first ambient
  declaration in `foundry-globals.d.ts` that isn't a Document/collection
  shape. `POST /api/rolls` evaluates a formula and returns a normalized
  `{formula, total, result, dice}` — it does not post anything to chat,
  matching PLAN.md's separation of "Roll formula evaluation" from "Chat
  Messages" into two bullet points.
- Chat messages, by contrast, needed zero new ambient declarations:
  `ChatMessage` is a regular Foundry document type already covered by Phase
  8's generic `game.collections`/`CONFIG` surface. `GET/POST /api/chat`
  (`shared/src/chat.ts`, `server/src/endpoints/chat.ts`,
  `module/src/commands/chat.ts`) are still hand-rolled rather than routed
  through the Phase 8 `makeDocumentEndpoints()` factory, though: PLAN.md's
  Phase 14 text calls for only create + a bounded "recent log" read, not full
  CRUD, and letting a caller edit or delete arbitrary past chat history
  wasn't asked for. `GET /api/chat` takes an optional `limit` (coerced from
  the query string) and returns the most recent N messages, oldest first,
  rather than the factory's unbounded full-collection dump.
- Phase 14's tests cover both new endpoints directly (rolls: formula
  evaluation, optional roll `data`, validation; chat: list, `limit`,
  send) — no generic factory backs either, so nothing here is proven by an
  earlier phase's tests. Same untested-against-a-live-instance caveat as
  Phases 6–13 applies to both new module-side handlers
  (`module/src/commands/rolls.ts`, `module/src/commands/chat.ts`); flagged
  for a live smoke-test (a real dice formula through Foundry's actual `Roll`
  engine, and a real chat message appearing in a connected client's log)
  whenever a Foundry instance is available.
- Phase 15 needed no new work for Macro CRUD itself: it reuses the Phase 8
  `makeDocumentEndpoints()` factory with `documentType: "Macro"`, identical
  to JournalEntry/Actor/Item/Scene. The one macro-specific extra PLAN.md's
  Phase 15 text calls for — execution — is hand-rolled in new `shared/src/
  macros.ts` (`MACRO_COMMANDS`), `server/src/endpoints/macros.ts`, and
  `module/src/commands/macros.ts`, following the same "factory + extras"
  shape Phases 9/11 established.
- Phase 15's "explicit safety flag/scope" requirement (PLAN.md's own wording)
  is implemented as a new optional `annotations` field on `EndpointDescriptor`
  (`server/src/endpoints/types.ts`), carrying the MCP SDK's own
  `ToolAnnotations` hint object (`title`/`destructiveHint`/`openWorldHint`/
  etc.) through `registerMcpTool()` (`server/src/endpoints/registry.ts`) to
  `mcpServer.registerTool()`. `foundry_execute_macro` is the first (and so
  far only) descriptor to set it — `destructiveHint: true` plus a title
  calling out that it runs arbitrary JavaScript. Per the MCP spec these
  annotations are advisory hints only, not server-enforced, so the
  descriptor's `description` string also states the danger in plain
  language for any human or LLM reading the tool catalog; nothing about
  actual execution privilege changed (the bridge has always been
  single-API-key, full-privilege, per Phase 4's design).
- Phase 15 added `FoundryMacro` (`execute()`) to
  `module/src/types/foundry-globals.d.ts`, layered on the generic
  `FoundryDocument` shape same as every other document-specific interface
  since Phase 9 — Foundry routes a macro's stored script/chat command through
  its own `execute()` method exactly as the in-client macro bar does, so no
  other new ambient surface was needed.
- Phase 15's tests cover the execute extra (including a direct assertion
  that its descriptor carries `destructiveHint: true`) plus a smoke check
  that `macroEndpointDescriptors` mounts CRUD under `/api/macros` — base
  CRUD itself is already proven generic by Phase 8's tests. Same
  untested-against-a-live-instance caveat as Phases 6–14 applies to the
  module-side handler (`module/src/commands/macros.ts`); flagged for a live
  smoke-test (both script-type and chat-type macros against a real world)
  whenever a Foundry instance is available.
- Phase 16 needed no new work for Combat CRUD itself: it reuses the Phase 8
  `makeDocumentEndpoints()` factory with `documentType: "Combat"`, identical
  to JournalEntry/Actor/Item/Scene/Macro. The extras PLAN.md's Phase 16 text
  calls for (start/next-turn/next-round/end, add/remove combatant, roll
  initiative) are hand-rolled in new `shared/src/combats.ts`
  (`COMBAT_COMMANDS`), `server/src/endpoints/combats.ts`, and
  `module/src/commands/combats.ts`, following the same "factory + extras"
  shape Phases 9/11/15 established.
- PLAN.md's Phase 16 wording is "add/remove combatant" (not "CRUD
  combatant"), narrower than Phase 12's Token wording — so only embedded
  Combatant create/delete were added, not a separate list/get/update; a
  Combat document's own `toObject()` (returned by every extra here, same
  convention as Phase 11's scene `activate`) already includes its
  `combatants` array, so a standalone list/get command would be redundant,
  and no requirement called for editing a combatant's fields directly.
- Roll initiative is a single endpoint that branches module-side on whether
  `combatantIds` is given: with ids, it calls Foundry's `Combat#rollInitiative
  (ids)`; with none, it calls `Combat#rollAll()` (rolls every combatant
  currently missing initiative) — this maps PLAN.md's single "roll
  initiative" bullet onto Foundry's two real methods without exposing them
  as two separate tools for what a natural-language MCP caller ("roll
  initiative for everyone" vs. "roll initiative for these two combatants")
  experiences as one action with an optional scope.
- Phase 16 added `FoundryCombat` (`startCombat()`/`nextTurn()`/`nextRound()`/
  `endCombat()`/`rollInitiative()`/`rollAll()`/embedded `combatants`/
  `createEmbeddedDocuments()`) to `module/src/types/foundry-globals.d.ts`,
  layered on the generic `FoundryDocument` shape same as every other
  document-specific interface since Phase 9 — no other new ambient surface
  was needed.
- Phase 16's tests cover all seven extras directly (start/next-turn/
  next-round/end/add-combatant/remove-combatant/roll-initiative, including
  both the specific-ids and roll-all branches) plus a smoke check that
  `combatEndpointDescriptors` mounts CRUD under `/api/combats` — base CRUD
  itself is already proven generic by Phase 8's tests. Same
  untested-against-a-live-instance caveat as Phases 6–15 applies to the
  module-side handler (`module/src/commands/combats.ts`); flagged for a live
  smoke-test (starting a real encounter, turn/round advancement, and
  initiative rolling against a connected system) whenever a Foundry instance
  is available.
- Phase 17 needed no new work for Playlist CRUD itself: it reuses the Phase 8
  `makeDocumentEndpoints()` factory with `documentType: "Playlist"`, identical
  to JournalEntry/Actor/Item/Scene/Macro/Combat. The extras PLAN.md's Phase 17
  text calls for (play/stop/pause sound) are hand-rolled in new `shared/src/
  playlists.ts` (`PLAYLIST_COMMANDS`), `server/src/endpoints/playlists.ts`,
  and `module/src/commands/playlists.ts`, following the same "factory +
  extras" shape Phases 9/11/15/16 established. PLAN.md's wording is "play/
  stop/pause sound" (singular), so only single-sound operations were added —
  no `playAll`/`stopAll`, consistent with Phase 16's narrow reading of its own
  "add/remove combatant" wording.
- Foundry's `Playlist` class only exposes `playSound()`/`stopSound()`
  (confirmed against the current Foundry API docs) — there is no dedicated
  "pause" method. Foundry's own playlist sidebar implements pausing as a
  plain `PlaylistSound#update()` that flips `playing` to `false` and records
  the sound's current position in `pausedTime`, which a later `playSound()`
  resumes from; Phase 17's pause handler
  (`module/src/commands/playlists.ts`) replicates that directly rather than
  inventing new Foundry API surface.
- All three extras return the affected embedded `PlaylistSound`'s own
  `toObject()` (not the parent Playlist's), even though `playSound()`/
  `stopSound()` themselves resolve with the updated Playlist — re-reading the
  specific sound off the playlist's `sounds` map after the call keeps the
  return shape consistent across all three extras (a caller asked about one
  sound gets that sound back), consistent with how every embedded-create
  descriptor since Phase 10 returns the created child, not the parent.
- Phase 17 added `FoundryPlaylist` (`playSound()`/`stopSound()`, embedded
  `sounds`) and `FoundryPlaylistSound` (`playing`/`pausedTime`/the underlying
  `sound.currentTime`) to `module/src/types/foundry-globals.d.ts`, layered on
  the generic `FoundryDocument` shape same as every other document-specific
  interface since Phase 9 — no other new ambient surface was needed.
- Phase 17's tests cover all three extras directly (play/stop/pause) plus a
  smoke check that `playlistEndpointDescriptors` mounts CRUD under
  `/api/playlists` — base CRUD itself is already proven generic by Phase 8's
  tests. Same untested-against-a-live-instance caveat as Phases 6–16 applies
  to the module-side handler (`module/src/commands/playlists.ts`); flagged
  for a live smoke-test (play/stop/pause against a real playlist, including
  verifying `pausedTime` actually resumes correctly) whenever a Foundry
  instance is available.
- Phase 18 split into two document types, each needing no new work for its
  own CRUD: RollTable and Cards both reuse the Phase 8
  `makeDocumentEndpoints()` factory (`documentType: "RollTable"` /
  `"Cards"`), identical to JournalEntry/Actor/Item/Scene/Macro/Combat/
  Playlist. PLAN.md's Phase 18 text calls for "draw-from-table" (RollTable)
  and "card pile operations" (Cards, plural) — hand-rolled in new
  `shared/src/roll-tables.ts` / `shared/src/cards.ts`,
  `server/src/endpoints/roll-tables.ts` / `cards.ts`, and
  `module/src/commands/roll-tables.ts` / `cards.ts`, following the same
  "factory + extras" shape Phases 9/11/15/16/17 established.
- RollTable's one extra is `draw`, a thin wrapper over `RollTable#draw()`
  (Foundry's own table-draw method, which evaluates the table's roll formula
  and returns the matching `TableResult`(s)); an optional `displayChat` body
  field is forwarded when given and otherwise left to Foundry's own default
  (`true`, i.e. posts to chat) — PLAN.md's Phase 18 wording is a single verb
  ("draw"), so no separate "draw without posting to chat" tool was added, an
  optional flag was judged sufficient.
- Cards' "card pile operations" (plural) was read as the three operations
  Foundry's own `Cards` document actually exposes for moving/reordering
  cards: `draw` (move cards from a source stack into this one, e.g. a deck
  into a hand), `shuffle` (randomize this stack in place), and `reset`
  (recall every card dealt out of this stack back into it) — narrower verbs
  like `pass`/`deal` (moving cards between two *other* stacks, or one stack
  to many) exist on Foundry's `Cards` class too but weren't added, consistent
  with Phase 16's own narrow reading of its "add/remove combatant" wording
  rather than building out every related method.
- `draw` returns the drawn Card documents' own data (consistent with every
  embedded-create descriptor since Phase 10); `shuffle`/`reset` return the
  affected Cards stack's own `toObject()` (consistent with Phase 11's scene
  `activate` and Phase 16's turn/round descriptors).
- Phase 18 added `FoundryRollTable` (`draw()`) and `FoundryCardsStack`
  (`draw()`/`shuffle()`/`reset()`) to
  `module/src/types/foundry-globals.d.ts`, layered on the generic
  `FoundryDocument` shape same as every other document-specific interface
  since Phase 9. Named `FoundryCardsStack` rather than `FoundryCards` to
  avoid colliding with Foundry's own global `Cards` document class name.
  RollTable/Cards CRUD itself uses the generic `FoundryDocument`/
  `FoundryDocumentClass` shapes unchanged.
- Phase 18's tests cover the RollTable draw extra and all three Cards extras
  directly, plus a smoke check per document type that its descriptors mount
  CRUD under `/api/roll-tables` and `/api/cards` respectively — base CRUD
  itself is already proven generic by Phase 8's tests. Same
  untested-against-a-live-instance caveat as Phases 6–17 applies to both new
  module-side handlers (`module/src/commands/roll-tables.ts`,
  `module/src/commands/cards.ts`); flagged for a live smoke-test (a real
  table draw including its chat-post behavior, and a real deck-to-hand
  draw/shuffle/reset) whenever a Foundry instance is available.
- Phase 19 needed no new work for Folder CRUD itself: it reuses the Phase 8
  `makeDocumentEndpoints()` factory with `documentType: "Folder"`, identical
  to JournalEntry/Actor/Item/Scene/Macro/Combat/Playlist/RollTable/Cards. The
  one extra PLAN.md's Phase 19 text calls for ("move documents between
  folders") is hand-rolled in new `shared/src/folders.ts`
  (`FOLDER_COMMANDS`), `server/src/endpoints/folders.ts`, and
  `module/src/commands/folders.ts`, following the same "factory + extras"
  shape Phases 9/11/15/16/17/18 established.
- The move extra is read generically, not folder-scoped: `documentType`
  travels in the payload the same way it does for the Phase 8 generic
  document commands, because the document being moved is any
  folder-capable document (Actor, Item, JournalEntry, Scene, Macro,
  Playlist, RollTable, Cards, or a Folder itself being renested under
  another Folder) — not a Folder. Its handler is a thin wrapper over the
  moved document's own `update({ folder: folderId })`, consistent with
  Phase 11's `activate`/Phase 12's `move` both wrapping a plain `update()`
  rather than inventing new Foundry API surface; `folderId: null` moves the
  document to the root, matching Foundry's own convention for an unfiled
  document's `folder` field.
- Phase 19 needed no new ambient declaration in
  `module/src/types/foundry-globals.d.ts`: the move handler only calls
  `game.collections.get(documentType)` and the generic `FoundryDocument#
  update()`/`toObject()`, both already declared by Phase 8. Folder CRUD
  itself likewise uses the generic `FoundryDocument`/`FoundryDocumentClass`
  shapes unchanged.
- Phase 19's tests cover the move extra (both moving into a folder and
  moving to the root with `folderId: null`) plus a smoke check that
  `folderEndpointDescriptors` mounts CRUD under `/api/folders` — base CRUD
  itself is already proven generic by Phase 8's tests. Same
  untested-against-a-live-instance caveat as Phases 6–18 applies to the
  module-side handler (`module/src/commands/folders.ts`); flagged for a live
  smoke-test (moving a real document into and out of a folder, and renesting
  a folder itself) whenever a Foundry instance is available.
- Phase 20 could not reuse the Phase 8 `makeDocumentEndpoints()` factory at
  all, unlike every document-CRUD phase since (JournalEntry/Actor/Item/
  Scene/Macro/Combat/Playlist/RollTable/Cards/Folder): a compendium pack has
  no `game.collections` entry of its own — packs live on their own top-level
  `game.packs` collection, keyed by pack id (e.g. `"world.my-macros"` or
  `"dnd5e.monsters"`). So all seven descriptors (list packs, read a pack's
  index, get/create/update/delete an entry, import an entry into the world)
  are hand-rolled in new `shared/src/packs.ts` (`PACK_COMMANDS`),
  `server/src/endpoints/packs.ts`, and `module/src/commands/packs.ts`, under
  `/api/packs[/:packId/index | /:packId/entries[/:entryId[/import]]]`,
  following the same `<parent>Id`/`<child>Id` embedded-id shape (packId/
  entryId) Phase 12 established for embedded tokens.
- Get/update/delete of a single pack entry needed no new Foundry API surface
  beyond loading it: once a document is loaded via
  `CompendiumCollection#getDocument(id)`, it's a regular `FoundryDocument`
  whose own `.update()`/`.delete()` already route back to the pack it came
  from — the same finding Phase 10 made for embedded documents routing
  through their parent. Only entry creation needed a new option,
  `FoundryDocumentClass#create(data, { pack: <packId> })`, since there's no
  existing document instance to route through yet for a not-yet-created
  entry (mirrors Phase 10's finding that only embedded creation needed new
  ambient surface, for the same reason).
- Importing an entry into the world uses Foundry's own
  `WorldCollection#importFromCompendium(pack, id)` (found on the values of
  `game.collections`, e.g. `game.actors`) rather than hand-rolling
  "load the entry then re-create it in the world," since Foundry's real
  method already handles the folder/ownership/sort cleanup that a naive
  re-create would need to replicate — consistent with Phase 11's dimensions
  endpoint preferring Foundry's own computed values over re-deriving them.
- `game.collections`' value type was widened from a bare
  `Map<string, FoundryDocument>` to a new `FoundryWorldCollection` interface
  (`module/src/types/foundry-globals.d.ts`) that extends that same `Map`
  shape with `importFromCompendium()` — every earlier phase's
  `game.collections.get(type)` call site is unaffected, since a
  `FoundryWorldCollection` is still a `Map<string, FoundryDocument>` for
  every method they actually use.
- Phase 20 added `game.packs` (`FoundryCompendiumCollection`, covering
  `metadata`/`index`/`getIndex()`/`getDocument()`/`documentClass`) to
  `module/src/types/foundry-globals.d.ts`, following the same minimal/
  hand-rolled approach as every ambient declaration since Phase 6 — no
  per-document-type schema, just the subset of the real `CompendiumCollection`
  API this phase's handlers actually call.
- Phase 20's tests cover all seven descriptors directly, since none of them
  are backed by an already-tested generic factory (same rationale as Phase
  12's tokens and Phase 13's journal pages). Same untested-against-a-live-
  instance caveat as Phases 6–19 applies to the module-side handler
  (`module/src/commands/packs.ts`); flagged for a live smoke-test (reading a
  real system-provided compendium's index, CRUD against a world-owned pack,
  and importing a real entry — e.g. a monster from a dnd5e compendium — into
  the world) whenever a Foundry instance is available.
- Phase 21 is the first embedded-collection phase where the embedded type
  (ActiveEffect) hangs off *two* different parent document types (Actor,
  Item) rather than one fixed parent (contrast Phase 10's Item, always on an
  Actor; Phase 12's Token, always on a Scene; Phase 13's JournalEntryPage,
  always on a JournalEntry). Rather than hand-rolling a full set of
  descriptors/commands per parent type the way Phase 20 hand-rolled packs,
  Phase 21 generalizes: `shared/src/active-effects.ts`'s five
  `EMBEDDED_EFFECT_COMMANDS` and their payload shapes all carry an explicit
  `parentType: "Actor" | "Item"` field alongside `parentId`, and
  `server/src/endpoints/active-effects.ts` defines one factory,
  `makeEmbeddedEffectEndpoints({parentType, routeBase, toolPrefix})` —
  mirroring Phase 8's `makeDocumentEndpoints()` — called twice (once for
  Actor, once for Item) to build `/api/actors/:parentId/effects[/:effectId]`
  and `/api/items/:parentId/effects[/:effectId]`. `parentType` itself is
  baked into each call's descriptors via closure, not read off the request,
  since a given REST route only ever serves one parent type.
- Module-side, `module/src/commands/active-effects.ts` resolves the parent
  generically off `game.collections.get(parentType)` rather than assuming a
  fixed `Actor` collection the way Phase 10's `items.ts` does. This needed a
  new `FoundryItem` ambient interface (`module/src/types/foundry-globals.d.ts`)
  — the first time an Item needs its own typed shape beyond generic
  `FoundryDocument`/`FoundryDocumentClass` — carrying the same
  `effects`/`createEmbeddedDocuments()` shape now also added to `FoundryActor`.
- Phase 21's tests cover all five CRUD operations against the Actor-parented
  routes, plus one additional list request against the Item-parented route
  to prove the second `makeEmbeddedEffectEndpoints()` call wires up its own
  `parentType`/`routeBase` independently rather than colliding with the
  first (same "factory is generic, independent per call" assertion Phase 8's
  `documents.test.ts` makes for `makeDocumentEndpoints()`). Same untested-
  against-a-live-instance caveat as Phases 6–20 applies to the module-side
  handler; flagged for a live smoke-test (creating/toggling/deleting a real
  ActiveEffect on both an Actor and an owned Item) whenever a Foundry
  instance is available.
- Phase 22 is the first Batch A phase, worked sequentially in one sitting
  rather than in parallel (the batching in "Execution Batching" above exists
  to bound merge-conflict risk when phases run as separate parallel agents;
  working them one after another in a single session makes that risk moot,
  but the phase boundaries and independent-file ownership still held).
- Phase 22 has six placeable document types (Drawing, Note, AmbientLight,
  AmbientSound, Wall, MeasuredTemplate) all embedded on the same parent
  (Scene) — the mirror image of Phase 21's ActiveEffect (one embedded type,
  two possible parents). So it defines one factory,
  `makeEmbeddedPlaceableEndpoints({documentType, routeBase, toolPrefix})`
  (`server/src/endpoints/placeables.ts`), called once per placeable type,
  with `documentType` baked in via closure — the same shape as Phase 21's
  `makeEmbeddedEffectEndpoints()` with the axis of variation flipped.
- Module-side, Phase 22 resolves each placeable type's embedded collection
  generically via a new `FoundryScene#getEmbeddedCollection(embeddedName)`
  ambient method (`module/src/types/foundry-globals.d.ts`) rather than
  hand-naming all six of Scene's actual collection properties (`drawings`/
  `notes`/`lights`/`sounds`/`walls`/`templates`) — Foundry's own Document API
  already exposes this generic accessor, and using it means adding a
  placeable type later needs no new per-type property mapping.
- The camera pan/zoom extra PLAN.md's Phase 22 text calls for is
  scene-independent (it pans whatever the connected client currently has
  rendered, via Foundry's own `canvas.animatePan()`), so it's a single
  `POST /api/canvas/pan {x?, y?, scale?}` endpoint rather than nested under
  any one scene's route. It throws if no canvas is currently active (no
  scene being viewed) rather than silently no-opping.
- Phase 22 reconfirmed the `exactOptionalPropertyTypes` convention Phase
  14/18 established: an optional field on a shared payload interface must be
  typed `field?: T | undefined`, not just `field?: T`, or the zod schema
  that backs it fails to type-check against it.
- Phase 23's document-ownership extra is generic across document type, like
  Phase 19's folder-move, but unlike folder-move it fits a natural resource
  path — so it introduces the first cross-document-type REST route base,
  `/api/documents/:documentType/:documentId/ownership`, with `documentType`
  as a path segment rather than a body field. No new ambient module-side
  surface was needed: ownership is just the standard `ownership` field
  already covered by `FoundryDocument#toObject()`/`update()`.
- Phase 23 reads PLAN.md's "world permission levels per user" narrowly, as a
  User document's own `role` field (`CONST.USER_ROLES`), exposed as
  `GET/PUT /api/users/:userId/role` — not full User CRUD, which PLAN.md's
  own Phase 25 text calls for separately. Consistent with Phase 16/17/19's
  precedent of reading a phase's own wording narrowly. This needed one new
  ambient method, `FoundryUser#update()` (a User is itself a Document, so
  setting `role` is the same generic `.update(changes)` every other
  document-specific interface already exposes).
- Phase 24's upload endpoint carries file content as base64 in the JSON
  body — the bridge protocol (`shared/src/protocol.ts`) is JSON-only end to
  end, with no multipart/binary channel, so this was the only option without
  redesigning the transport. The module decodes it into a real `File` before
  handing it to Foundry's own `FilePicker.upload()`. This pushed the
  default 100kb `express.json()` body limit (`server/src/app.ts`) up to
  50mb — too small a limit would make the endpoint unusable for realistic
  image/audio assets (base64 already inflates size ~33%), and Foundry's own
  server still enforces its real upload rules (extension allow-list, size
  caps, per-source permissions) independently of this limit.
- Phase 24 is a thin pass-through to Foundry's own `FilePicker` static class
  (browse/upload/createDirectory) — no attempt was made to reimplement
  Foundry's upload security model client- or server-side, consistent with
  the phase's own "respecting Foundry's upload security model" wording
  meaning "don't bypass it," not "reimplement it here."
- Phase 24 added the `FilePicker` ambient class
  (`module/src/types/foundry-globals.d.ts`) — the second ambient declaration
  in this file that isn't a Document/collection shape (after Phase 14's
  `Roll`).
- Phases 22–24's tests all cover their descriptors directly against a mocked
  Express app + fake `FoundryClient`, the same integration-test template
  every phase since Phase 20 uses. Same untested-against-a-live-instance
  caveat as every phase since 6 applies to all three new module-side
  handlers (`module/src/commands/placeables.ts`,
  `module/src/commands/permissions.ts`, `module/src/commands/files.ts`);
  flagged for a live smoke-test (placeable CRUD and camera pan against a
  real scene, ownership get/set and a role change against a real user, and
  a real file browse/upload/directory-create against a running Foundry data
  directory) whenever a Foundry instance is available.
- Phase 25 (Batch B) did not re-implement `GET /api/users` (list): it already
  exists as `foundry_list_users` from Phase 6's read-only enumeration.
  Re-registering it would either collide with Phase 6's route (Express: first
  registered handler wins) or need a duplicate MCP tool name (`registerTool`
  throws on a name collision) — so "User CRUD" here is get-by-id/create/
  update/delete only (`shared/src/users.ts`'s `USER_COMMANDS`,
  `server/src/endpoints/users.ts`, `module/src/commands/users.ts`), list
  stays Phase 6's. The get-by-id tool is named `foundry_get_user_by_id`, not
  `foundry_get_user` — that name is already taken by Phase 6's "current
  connected user" descriptor (`GET /api/user`, no id).
- Phase 25's create/update/delete are GM-only, enforced module-side
  (`requireGM()` throwing a plain `Error`, turned into a `HANDLER_ERROR` 500
  by the existing bridge-error plumbing) — same convention as Phase 7's
  world-scope settings write, since the server has no notion of which
  Foundry user is making a request beyond the single static API key. User
  creation needed no new ambient "static creator" declaration:
  `CONFIG.User.documentClass` already exists via Phase 8's generic `CONFIG`
  surface (User is a regular registered Document type in real Foundry, same
  as Actor/Item/etc.).
- Phase 25's canvas selection (`GET /api/canvas/selection`) is read-only and
  scene-independent, a direct sibling of Phase 22's `/api/canvas/pan` — same
  "no active canvas" thrown-error precedent. It returns `{sceneId,
  tokenIds}`, reading `canvas.tokens.controlled` (Token placeables) and
  mapping each to its underlying `.document.id` (TokenDocument), not the
  placeable's own `.id`. This needed a new `FoundryPlaceable` ambient
  interface (`id`/`document`) and widened the ambient `canvas` type with
  `scene`/`tokens.controlled` (`module/src/types/foundry-globals.d.ts`). User
  targeting (`game.user.targets`) was deliberately skipped — PLAN.md's own
  Phase 25 wording anchors "current selection/targeting" specifically to the
  parenthetical `canvas.tokens.controlled`, and adding targeting would mean a
  second, differently-shaped (`Set`-based, per-user) ambient surface for
  something the phase text doesn't distinctly ask for.
- Phase 27 (Batch B) wraps both `game.i18n.localize(key)` and
  `game.i18n.format(key, data)` behind one `GET /api/localize`
  (`shared/src/localization.ts`, `server/src/endpoints/localization.ts`,
  `module/src/commands/localization.ts`), branching module-side on whether
  `data` is present — one action with an optional interpolation payload,
  consistent with Phase 16's roll-initiative branching precedent, rather than
  two separate tools. This needed the first ambient `game.i18n` declaration
  (`GameI18n` interface: `localize`/`format`/`has`) in
  `module/src/types/foundry-globals.d.ts`.
- Phase 27's `/api/localize` hit a real Express 5 gotcha: this project's
  Express version defaults to the "simple" query parser (plain Node
  `querystring`), not Express 4's `qs`-backed "extended" parser, so
  bracket-notation (`data[name]=Bob`) does not nest into an object on `GET`.
  Fixed by carrying `data` as a JSON-encoded string in the query param
  instead, parsed via a zod `.transform()` that raises a proper 400
  (`ctx.addIssue`) on malformed JSON rather than a raw parse-time 500 — this
  is the pattern any future GET endpoint needing a structured query value
  should copy.
- Phase 27's HTML enrichment (`POST /api/enrich-html`) is a thin pass-through
  to Foundry's `TextEditor.enrichHTML(content)` — `{content}` in, `{html}`
  out, no `options` passthrough, since PLAN.md's own wording is just "HTML
  enrichment," not "with full options control." This is the third
  non-Document/collection ambient declaration in `foundry-globals.d.ts`
  (after Phase 14's `Roll` and Phase 24's `FilePicker`), a hand-rolled
  minimal `TextEditor` class with just `static enrichHTML()`.
- Phase 27's "in-world search, if applicable" was implemented, not skipped:
  `GET /api/search?query=...&types=Actor,Item` (types optional,
  comma-separated, defaults to every `game.collections` entry), doing
  case-insensitive substring matching against each document's
  `toObject().name`. This needed zero new ambient declarations — it resolves
  entirely off the already-declared generic `game.collections`/
  `FoundryDocument` surface from Phase 8. Foundry's real `SearchFilter` class
  was deliberately rejected as the basis: it's a UI-focused utility built for
  the sidebar's live filter box, not a clean queryable API, matching the risk
  the plan's own "if applicable" hedge was flagging.
- Phase 26 (Batch B) is the first phase where the *module* pushes unsolicited
  data to the server, rather than only replying to a server-initiated
  `FoundryClient.call()`. The bridge protocol
  (`shared/src/protocol.ts`) gained `BridgeEventMessage<TPayload>` — a
  `{kind: "event", event, payload}` shape distinguished from
  `BridgeRequest`/`BridgeResponse` by the `kind` field neither of those has
  ever carried, so detection in `FoundryClient.handleMessage()`
  (`server/src/bridge/foundry-client.ts`) is unambiguous with no schema
  versioning needed. `FoundryClient` gained `onEvent(listener): () =>
  void`, a `Set`-based listener registry mirroring
  `BridgeGateway.onMessage`/`onConnectionLost`
  (`server/src/bridge/gateway.ts`), checked before the existing
  response-shape parsing so normal request/response handling is untouched.
- Phase 26's server-side event fan-out is a new dependency-free
  `FoundryEventBus` (`server/src/events/event-bus.ts`): `publish`/
  `subscribe` (returns an unsubscribe fn) for live listeners, plus a
  200-entry ring buffer read via `recent(limit?)` for polling. It's wired in
  `server/src/index.ts` (`foundryClient.onEvent(...) → eventBus.publish(...)`)
  and stashed on `app.locals["eventBus"]`, resolved per-request the same way
  `foundryClient` already is (`server/src/endpoints/registry.ts`'s documented
  convention) — deliberately NOT added to `CreateAppOptions`
  (`server/src/app.ts`), which would have forced every one of the ~20
  existing `*.test.ts` files' `createApp({...})` calls to change.
  `EndpointContext.eventBus` (`server/src/endpoints/types.ts`) is optional
  for the same reason.
- Phase 26's REST side, `GET /api/events` (SSE), doesn't fit the
  `EndpointDescriptor` pattern (a descriptor handler runs once and
  `res.json()`s its result; SSE holds the connection open and `res.write()`s
  repeatedly) — hand-rolled in `server/src/endpoints/events-sse.ts` and
  mounted directly on `apiRouter` in `server/src/routes/api.ts`, after
  `mountRestEndpoints()`, the same "pattern doesn't fit, hand-roll instead"
  precedent as `/health` and Phase 20's pack routing. It still runs behind
  the `/api` mount's CORS/rate-limit/auth chain since it shares `apiRouter`.
  The handler function is exported standalone specifically so it's
  unit-testable against fake req/res objects — a genuinely open SSE response
  never resolves a normal supertest request, so no live-streaming supertest
  assertion was attempted (`server/src/endpoints/events-sse.test.ts`).
- Phase 26's MCP side reads PLAN.md's "subscribable resource/notification
  stream" narrowly, as a plain descriptor-pattern polling tool
  (`foundry_get_recent_events`, `GET /api/events/recent?limit=N`,
  `server/src/endpoints/events.ts`) rather than true MCP resource
  subscriptions: the installed `@modelcontextprotocol/sdk@1.30.0` has
  `registerResource()`/`sendResourceUpdated()`/`sendResourceListChanged()`
  but implements no `resources/subscribe`/`unsubscribe` request handling at
  either the `McpServer` or low-level `Server` layer (verified against its
  `.d.ts` files) — real subscriptions would mean hand-rolling protocol-level
  request handlers, a materially larger change than this phase's own
  "if applicable"-adjacent scope warrants, consistent with the project's
  precedent (Phase 15/21/22) of preferring a working, well-tested narrower
  solution. `shared/src/events.ts` is the first shared domain file with no
  `*_COMMANDS` map: recent events are read straight off the server-side
  `FoundryEventBus`, never round-tripped through the bridge — the first
  server-only (not module-backed) endpoint in the codebase.
- Phase 26's module-side hook forwarding lives at `module/src/hooks.ts`, not
  under `commands/`: every file in `commands/` registers inbound
  `BridgeRequest` handlers via `command-registry.ts`'s `dispatch()`; this
  file only originates outbound pushes and never participates in `dispatch()`.
  `registerHookForwarding(client)` is called once from `module/src/index.ts`'s
  `ready` hook, right after constructing the `BridgeClient` — inversion of
  control was preferred over exporting the client instance, keeping the diff
  to `index.ts`'s `ready` hook body to one line. `module/src/bridge-client.ts`
  gained a public `sendEvent(event, payload)`, a sibling to the existing
  private `send()`, mirroring its readyState-check idiom.
- Phase 26's curated hook list is `createActor/updateActor/deleteActor`,
  `createItem/updateItem/deleteItem`, `createToken/updateToken/deleteToken`,
  `createChatMessage` — narrow and explicit, consistent with Phase 16/17/19's
  precedent of not building out every related hook/method. PLAN.md's own
  wording names `chatMessage` as an example, but that isn't a real Foundry
  hook name; `createChatMessage` (ChatMessage is a regular lifecycle-hooked
  Document) is the real equivalent, used instead. Hook callback args are
  normalized via a `toObject()` duck-type check before forwarding, matching
  every `module/src/commands/*.ts` handler's existing convention of returning
  `.toObject()` rather than raw Document instances.
- Phases 25–27's tests all cover their descriptors directly against a mocked
  Express app + fake `FoundryClient`, the same integration-test template
  every phase since Phase 20 uses; Phase 26 additionally adds
  `server/src/bridge/foundry-client.test.ts` (new — none existed before this
  phase, covering both the pre-existing `call()`/response-handling behavior
  and the new `onEvent` behavior) and a standalone `FoundryEventBus` unit
  test with no Express involved. Same untested-against-a-live-Foundry-instance
  caveat as every phase since 6 applies to all four new module-side handlers
  (`module/src/commands/users.ts`, `module/src/commands/localization.ts`,
  `module/src/hooks.ts`, and `module/src/bridge-client.ts`'s new `sendEvent`);
  flagged for a live smoke-test (GM-gated user CRUD, canvas selection, a real
  localization key with/without interpolation data, a real `@UUID[...]`
  content-link enrichment, a search across a populated world, and real hook
  firings — actor/item/token create/update/delete, a chat message — actually
  reaching a connected SSE client and the `foundry_get_recent_events` tool)
  whenever a Foundry instance is available.
- Phase 28's four descriptors (`foundry_query_documents`,
  `foundry_batch_create_documents`, `foundry_batch_update_documents`,
  `foundry_batch_delete_documents`) are a new `shared/src/bulk.ts` /
  `server/src/endpoints/bulk.ts` / `module/src/commands/bulk.ts` trio rather
  than a sixth+ addition to Phase 8's `DOCUMENT_COMMANDS`/`documents.ts`:
  like Phase 8's own five commands, `documentType` travels in every payload,
  but these four are mounted once each (`/api/documents/query`,
  `/batch-create`, `/batch-update`, `/batch-delete`), not once per document
  type the way `makeDocumentEndpoints()`'s output is — so they don't fit the
  per-type-factory shape `documents.ts` is built around.
- Phase 28's batch create/update/delete call Foundry's native static
  bulk methods (`createDocuments()`/`updateDocuments()`/`deleteDocuments()`,
  new on `FoundryDocumentClass` in `module/src/types/foundry-globals.d.ts`)
  rather than looping N individual `.create()`/`.update()`/`.delete()` calls
  — one Foundry hook cycle and one bridge round-trip per batch, not N, which
  is the actual point of "cut round-trips for larger operations." Batch
  update sends each entry as `{_id: id, ...changes}`, matching
  `updateDocuments()`'s real Foundry signature (each update object carries
  its own target id rather than a separate id/changes pair).
- Phase 28's query endpoint is exact-match equality on a document's
  top-level `toObject()` fields only — no nested-field paths, no operators
  beyond equality, no sort — kept as small as PLAN.md's own one-line spec
  ("Generic filtered-query endpoint across document collections") calls for.
  It needed no new ambient Foundry surface at all, resolving entirely off
  Phase 8's existing `game.collections`/`FoundryDocument#toObject()` shapes.
  `module/src/commands/documents.ts`'s `requireCollection`/
  `requireDocumentClass` helpers were exported (previously module-private)
  so `bulk.ts` reuses the same "unknown document type" lookup/error logic
  instead of duplicating it.
- Same untested-against-a-live-Foundry-instance caveat as every phase since
  6 applies to Phase 28's module-side handlers (`module/src/commands/
  bulk.ts`) — flagged for a live smoke-test (a real batch create/update/
  delete round-trip, and a filtered query against a populated world) whenever
  a Foundry instance is available.
- Phase 29's re-audit found two real gaps (not documented design tradeoffs)
  and fixed both:
  - `module/src/commands/permissions.ts`'s `SET_OWNERSHIP`/`SET_USER_ROLE`
    handlers (Phase 23) had no `requireGM()` gate, unlike every other
    privilege-elevating write in the codebase (Phase 7's world-scope
    settings, Phase 25's user CRUD) — a non-GM caller could grant themselves
    `OWNER` on any document or promote their own account to `GAMEMASTER`.
    `server/src/endpoints/permissions.ts`'s `setUserRoleDescriptor`
    description already claimed "GM only," so this was a real enforcement
    gap, not an intentional narrowing. Fixed by adding the same
    `requireGM()` pattern Phase 7/25 established; the two reads (get
    ownership, get role) stay ungated, consistent with every other read in
    the codebase.
  - `server/src/app.ts`'s `express.json({ limit: "50mb" })` (raised globally
    for Phase 24's file-upload endpoint) applied to every route, including
    `/health`, which sits entirely outside the `/api` mount's rate
    limiter/auth chain — an unauthenticated caller could repeatedly send
    ~50mb bodies to `/health` (or any other route) with zero rate limiting.
    Fixed by scoping the 50mb limit to `POST /api/files/upload` only (a
    second `express.json()` mounted ahead of the default one, matched by
    path; `body-parser`'s internal `onFinished.isFinished(req)` check makes
    stacking two parsers safe) and dropping the app-wide default to 2mb.
  - Everything else audited clean: localhost-only bind (`parseHost` in
    `server/src/config.ts`) still refuses non-loopback without
    `ALLOW_REMOTE_BIND=true`; every `/api/*` route — including the Phase 26
    SSE endpoint and the Phase 24 upload route — is mounted on `apiRouter`
    behind the same CORS/rate-limit/auth chain (`server/src/app.ts`); rate
    limiting (`express-rate-limit`) covers that whole chain, nothing is
    mounted around it; the bridge `?apiKey=` query param
    (`server/src/bridge/gateway.ts`) is never logged (only generic
    "rejected"/"replaced" strings go to `console.warn`, and the Express
    request logger only runs on `/health`/`/api/*`, which never see the
    `/bridge` upgrade URL); the centralized error handler
    (`server/src/app.ts`) never returns a stack trace or `err.message` for
    5xx responses, only a fixed "Internal server error" string (`err`/its
    message is still logged server-side to the console for operators); the
    macro-execute `destructiveHint` annotation and warning text are still
    accurate; Phase 28's batch create/update/delete call the same
    ungated `.create()`/`.update()`/`.delete()`-equivalent Foundry static
    methods individual CRUD does, so batch doesn't bypass any check
    individual CRUD had (neither path has document-level permission checks
    — consistent with the rest of the codebase's "server/module trust the
    single API key" model). The Phase 24 file-upload endpoint's path
    handling (`FilePicker.browse`/`upload`/`createDirectory`) remains an
    intentional thin pass-through to Foundry's own upload security model,
    per Phase 24's existing deviation-log entry — not reimplemented or
    changed here.
- Phase 30's OpenAPI/MCP-catalog generator (`server/src/scripts/
  generate-docs.ts`) uses zod v4's built-in `z.toJSONSchema()` rather than
  adding the `zod-to-json-schema` package the original plan text
  anticipated — zod ^4.6.5 (already a dependency) ships native JSON Schema
  generation, making a third-party package for this redundant. It walks the
  same `allEndpointDescriptors` aggregator (`server/src/endpoints/index.ts`)
  every REST route and MCP tool is already generated from, so the two docs
  and the real server can't drift apart the way hand-maintained docs would.
- Phase 30's generator surfaced a real, pre-existing circular import
  (`endpoints/index.ts` → `events.ts` → `app.ts` → `routes/api.ts` →
  `endpoints/index.ts`) that's silently harmless in the real server
  (`index.ts` always enters via `app.ts` first) but throws a TDZ
  `ReferenceError` when a script enters via `endpoints/index.ts` directly,
  as documentation tooling naturally does. Worked around with a documented
  side-effect `import "../app.js"` placed first in the generator, forcing
  the same module-evaluation order production uses — no endpoint file was
  changed.
- Phase 30 bumped `module.json`'s `version` from `1.0.0` to `0.1.0` (no
  public release exists yet) and reworded its dnd5e
  `optionalIntegrations`/`relationships.recommends` entries to explicitly
  read as planned/not-yet-implemented — both were aspirational holdovers
  from early scaffolding that no longer matched reality, since Part 2's
  dnd5e integration (Phases 32–36) hasn't started. No `download` URL was
  added (none exists); flagged in the README as a known gap for whenever
  real hosting exists.
- Phase 31's `server/src/endpoints/registry.test.ts` targets small synthetic
  descriptors against a bare Express app and a fake/mock `McpServer`, not
  the real ~100 production descriptors — every other `*.test.ts` already
  proves `mountRestEndpoints`/`registerMcpTools` work via one real domain's
  descriptors end-to-end, so this file isolates the generator machinery
  itself (method mapping, `validateQuery`/`validateBody` wiring,
  `FoundryBridgeError` → REST status vs. MCP `isError: true`, `annotations`
  reaching `registerTool()`) from any one domain's business logic.
  Confirmed along the way: `EndpointDescriptor['method']` is the closed
  union `"get" | "post" | "put" | "delete"` — there is no `"patch"` case,
  in the type or in `registerRestRoute`'s switch; not a bug, just answering
  the question Phase 31's own spec asked.
- Phase 31 added `shared/src/commands.test.ts` (shared/'s first test file):
  `shared/src/` is almost entirely type-only, but its 25 exported
  `*_COMMANDS` object-literal maps are real runtime values —
  `module/src/command-registry.ts` dispatches through one global
  `Map<string, CommandHandler>` keyed by these exact strings, so a
  cross-domain value collision would silently clobber a handler. The tests
  assert global uniqueness across all 25 maps combined, not per-file
  correctness.
- Phase 31's `module/` coverage (0 → 21 tests) is deliberately partial:
  `BridgeClient`/`registerHookForwarding` need a real or heavily-mocked
  `game`/`Hooks`/`WebSocket` global to test meaningfully, and building that
  harness was ruled out of scope for this phase. Instead it tests the pure
  logic already extracted for exactly this reason —
  `computeBackoffDelayMs`/`buildBridgeConnectionUrl` (`bridge-client.ts`)
  and `command-registry.ts`'s `dispatch()`/`registerCommand`/
  `unregisterCommand` — and exports two previously-private pure helpers in
  `hooks.ts` (`hasToObject`/`normalizeHookArg`), trivial and low-risk,
  specifically to test them the same way.
- Phase 31 found `format:check` already failing on 44 pre-existing files
  (unrelated to anything Phase 31 itself changed) before CI could be added
  meaningfully, so it ran `npm run format` once, repo-wide, and verified
  typecheck/lint/test/build all still passed after. One caveat this
  surfaced: Phase 30's `generate-docs.ts` writes `docs/openapi.json` via
  plain `JSON.stringify(doc, null, 2)`, which doesn't match Prettier's
  array-collapsing style — regenerating the docs will re-fail
  `format:check` until a future change makes that script Prettier-aware
  (e.g. piping its output through `prettier --write`).
- Phase 31's CI (`.github/workflows/ci.yml`) is a single job on
  `ubuntu-latest` / Node `20.x` (matching `engines.node: >=20`), running
  `npm ci` → typecheck → lint → format:check → test → build via
  `actions/setup-node`'s built-in npm cache — no matrix build, since
  nothing about this codebase has cross-platform/multi-version runtime
  concerns beyond what's already true.
- Phase 32's `Integration` interface (`server/src/integrations/types.ts`)
  adds `minVersion`/`maxVersion` gating beyond PLAN.md's literal text: a real
  interpretation choice, since the plan only specified the fields' presence,
  not what they're checked against. They're compared (inclusive bounds) not
  against Foundry's own core/system version but against the *matched*
  system's or module's own reported `version` (Phase 6's `SystemInfo`/
  `ModuleInfo`) — checked in addition to `detect()` passing, never instead of
  it, since `detect()` is what determines *which* system/module matched in
  the first place. The comparator (`server/src/integrations/version.ts`'s
  `isVersionInRange`) is a small hand-rolled dotted-numeric comparator, not a
  `semver` dependency — same "avoid a package when a small comparator
  suffices" precedent as Phase 30's `z.toJSONSchema()` deviation. A
  `kind: "module"` integration whose matched module can't be found in the
  active-modules list (shouldn't happen if `detect()` is written correctly,
  but not asserted) skips version gating entirely rather than erroring,
  since `detect()`'s own boolean is still the authority on whether it's
  "active" at all.
- Phase 32's dynamic REST router (`server/src/integrations/router.ts`)
  rebuilds a brand-new `express.Router()` from scratch on every
  `applyActiveIntegrations()` call rather than mutating one long-lived
  router — Express has no API to unregister a previously-mounted route, so
  "unmounting" an integration when it goes inactive can only be done by
  throwing the whole router away and building a fresh one. A module-level
  `currentRouter` pointer plus a thin `integrationRouterMiddleware`
  indirection (`(req, res, next) => currentRouter(req, res, next)`, mounted
  once by `routes/api.ts`) is what makes that swap invisible to Express's
  otherwise-static route table. Hit the same Express 5 (`path-to-regexp` v8)
  wildcard gotcha Phase 27 already found with the query parser, but a
  different manifestation of it: an inactive integration's catch-all route
  needs `router.all(\`/${id}/*splat\`, handler)` (a *named* wildcard
  segment) rather than the Express-4-style bare `/${id}/*`, plus a separate
  `router.all(\`/${id}\`, handler)` for the no-trailing-segment case, since a
  wildcard segment doesn't match zero path segments.
- Phase 32 changed `registerMcpTool`/`registerMcpTools`
  (`server/src/endpoints/registry.ts`) to return the MCP SDK's
  `RegisteredTool`/`RegisteredTool[]` instead of `void` — a pure additive
  change (every existing caller already ignored the return value) needed so
  `server/src/integrations/mcp-tools.ts` can call `.remove()` on a tool when
  its integration goes inactive, the MCP-side equivalent of the REST
  router's rebuild-from-scratch strategy (MCP tools, unlike Express routes,
  *can* be individually removed via the handle `registerTool()` itself
  returns).
- Phase 32 extended the Phase 30 doc generator
  (`server/src/scripts/generate-docs.ts`) to walk `integrations`
  (`server/src/integrations/registry.ts`) as a second, distinctly-marked
  source of descriptors: an `x-integration: {id, kind}` OpenAPI extension
  field on each integration endpoint's operation object (OpenAPI allows
  arbitrary `x-*` keys), and a separate `## Integration: <id> (<kind>)`
  section per integration in the Markdown tool catalog, noting that those
  tools only appear when that system/module is active in the connected
  world. Since `integrations` is empty until Phase 34, regenerating
  `docs/openapi.json`/`docs/mcp-tools.md` for this phase produced no
  semantic diff — the regenerated JSON was piped through `prettier --write`
  (per Phase 31's own noted caveat about `JSON.stringify`'s array formatting
  not matching Prettier's) before being checked in, and came out
  byte-identical to what was already committed.
- Phase 33's check needs to tell "declared in module.json but not yet built"
  (dnd5e, right now) apart from "should have code but doesn't" (a real drift
  bug) — PLAN.md's own Phase 33 wording only says the check should fail when
  a code registry entry has no "matching manifest entry", without saying how
  a not-yet-built integration should be represented so it doesn't trip that
  rule. This phase answers that gap with an `implemented?: boolean` flag
  (default `true` when omitted) on each `module.json`
  `flags["foundry-local-api"].optionalIntegrations[]` entry; the existing
  `dnd5e` entry (already marked "PLANNED, NOT YET IMPLEMENTED" only in its
  human-readable `description`) is now also flagged `"implemented": false`,
  and a manifest entry with `implemented: false` and no code counterpart is
  treated as the legitimate planned state rather than a mismatch. Being
  registered in `registry.ts` at all still IS the code-side "implemented"
  signal (no separate flag needed there); the diff also flags the reverse
  contradiction, a code-registered integration whose manifest entry still
  says `implemented: false`.
- Phase 33 split `check-manifest-sync.ts` into a pure
  `diffIntegrationManifestSync()` comparison function plus a thin
  `main()`/CLI shell that only handles file/module I/O and
  `process.exit()`, so the comparison logic is unit-testable
  (`check-manifest-sync.test.ts`) without touching the real `module.json` or
  registry — the same pure-logic/thin-glue split this codebase already uses
  elsewhere (`bridge-client.ts`'s extracted `computeBackoffDelayMs`/
  `buildBridgeConnectionUrl`, Phase 32's `IntegrationManager` tested against
  a fake `FoundryClient`).
- Unlike `generate-docs.ts` (which calls its `main()` unconditionally at the
  bottom of the file, safe because nothing ever imports from it), the first
  draft of `check-manifest-sync.ts` also called `main()` unconditionally —
  but `check-manifest-sync.test.ts` imports `diffIntegrationManifestSync`
  from that same module, so importing it for its pure function also ran
  `main()`'s real file-read/`process.exit()` side effects, killing the test
  process after only one test ran. Fixed by guarding the call with
  `if (fileURLToPath(import.meta.url) === process.argv[1])`, so `main()` only
  runs when the file is the actual CLI entry point, not merely imported —
  worth remembering for any future script under `src/scripts/` that, unlike
  `generate-docs.ts`, exports something a test file needs to import.
- Phase 34 is the first entry actually registered in the Phase 32/33
  integration framework (`server/src/integrations/registry.ts`'s
  `integrations` array goes from `[]` to `[dnd5eIntegration]`), and the
  **strongest version yet** of this project's running "no live instance"
  caveat applies to it — stronger than the routine one every phase since
  Phase 6 has carried for Foundry's own core API. Every prior phase read
  long-stable, extensively-documented core Foundry globals; this phase reads
  `CONFIG.DND5E` and an actor's live `system` data, both entirely
  system-defined and — per PLAN.md's own Phase 35 text — known to have
  "changed materially across dnd5e's 2.x -> 3.x -> 4.x releases." Here it's
  not just *whether* the documented API still behaves as documented that's
  unverified, but the *shape itself* being read. Treat every field-path
  assumption below as needing a live smoke-test against a real dnd5e world
  (ideally across more than one dnd5e version) before this is trusted in
  production:
  - `CONFIG.DND5E.abilities`/`skills`/`damageTypes`/`conditionTypes` are each
    assumed to be a flat `Record<string, {label, abbreviation?, ability?}>`;
    `label`/`abbreviation` values are passed through `game.i18n.localize()`
    unconditionally (safe no-op on an already-plain string, per Phase 27's
    existing `localize()` contract) since some dnd5e versions store i18n
    keys there rather than display strings. Any entry that isn't a plain
    object is skipped rather than crashing on `.label`, and a missing
    `CONFIG.DND5E` itself degrades to four empty arrays.
  - An actor's ability/skill/spell-slot/currency/senses data is read off a
    single narrow cast, `actor.system as Record<string, any>` — not a
    typed shape — with every individual field defaulted (`?? 0`/`?? {}`/
    `?? ""`) so a missing or renamed field degrades gracefully instead of
    throwing.
  - **Skill proficiency multiplier is read from `system.skills.<id>.value`,
    not `.proficient`** — dnd5e's own data model names the skill entry's
    proficiency-multiplier field `value`, which would collide confusingly
    with the result shape's own `proficient` key if passed through
    unrenamed, so it's explicitly remapped to `proficient` in
    `Dnd5eActorSheetResult` for a naming style consistent with `abilities`.
  - Class/level derivation: sums `system.levels` (assumed field path) off
    every embedded Item document whose `toObject().type === "class"`; if an
    actor has no class items at all (the expected case for an NPC actor,
    which typically has none), `level` falls back to
    `system.details.level` instead of summing an empty list to 0.
  - An item's `attuned` flag checks both `system.attuned` and (as a fallback)
    `system.attunement`, since the exact field name/representation for
    attunement state isn't confidently known to be stable across dnd5e
    versions.
  - An item's `activities` are read from `system.activities` as a keyed
    object (`Record<string, {name?, type?}>`, dnd5e 3.x+'s Activities
    system, serialized flat by `toObject()`) rather than an array; absent
    entirely (older dnd5e with no Activities system) or present-but-not-an-
    object both degrade to `[]`.
  - `module/src/types/foundry-globals.d.ts` gained `system: Record<string,
    unknown>` on both `FoundryActor` and `FoundryItem` — the first ambient
    ask for a document's *live, derived* runtime data (every earlier phase
    only ever needed `toObject()`'s pre-derived source data, which is
    missing computed fields like ability modifiers). Deliberately left
    generic/untyped rather than describing dnd5e's schema in this file,
    consistent with its established no-per-document-type/no-per-system
    minimalism; dnd5e-specific field access happens via the local casts
    above in `module/src/commands/dnd5e.ts`, not in the ambient declaration
    file itself.
  - The shared ambient `CONFIG` declaration
    (`{[documentType: string]: {documentClass: FoundryDocumentClass} |
    undefined}`) was deliberately left untouched rather than widened to
    include `DND5E` — every earlier phase's `CONFIG[documentType]?.
    documentClass` call site (documents.ts, users.ts, bulk.ts, etc.) depends
    on that exact shape, and `CONFIG.DND5E` is itself an entirely
    dnd5e-specific addition with no reason to appear in a system-agnostic
    ambient surface. Instead, `module/src/commands/dnd5e.ts` reaches it via
    one narrow local cast, `(CONFIG as unknown as {DND5E?: Record<string,
    unknown>}).DND5E`, scoping the assumption to the one file that needs it
    — the same "cast narrowly at the call site instead of widening a shared
    generic type" precedent already used elsewhere (e.g.
    `module/src/commands/permissions.ts`).
  - `module.json`'s `dnd5e` `optionalIntegrations[0].implemented: false` flag
    (Phase 33's convention) was removed entirely rather than flipped to
    `true` — both are equivalent to `check-manifest-sync.ts` (omitted
    defaults to `true`), and removing it reads more cleanly now that dnd5e
    is a real, code-registered integration rather than a declared-but-
    unbuilt placeholder. `description` and `relationships.recommends[0].
    reason` were reworded to describe what's actually implemented
    (read-only config/actor-sheet/inventory access) versus what's still
    planned (write actions — rolls, rests, spell slots, item/activity use —
    per PLAN.md's own Phase 35 text, not overclaimed beyond it).
  - As with every module-side command handler file since Phase 6,
    `module/src/commands/dnd5e.ts` has no direct unit test — Phase 31's
    deviation log already established that these need a real/heavily-mocked
    `game` global and aren't unit-tested; only the pure, extracted
    server-side descriptor logic
    (`server/src/integrations/dnd5e/endpoints.test.ts`) is. This file
    reuses the "small standalone Express app mounting the descriptors
    directly" harness style from `server/src/integrations/router.test.ts`/
    `server/src/endpoints/registry.test.ts`, including that same file's
    documented `import "../../app.js"` circular-import workaround (omitting
    it reproduces the exact `__name is not a function` runtime error
    `router.test.ts`'s header comment warns about).
- Phase 35 adds the seven write-action endpoints/tools on top of Phase 34's
  three read-only ones, under the same `/dnd5e/...` REST namespace and
  `dnd5e_`-prefixed MCP tools, following the exact descriptor/command/test
  pattern Phase 34 established. Same no-live-instance constraint as every
  phase since Phase 6, but this phase's blast radius if a guess is wrong is
  larger than Phase 34's: Phase 34 only reads game state, Phase 35 *writes*
  it (HP changes from rests, spent spell slots, consumed item charges) — so
  it's flagged for live smoke-testing at least as strongly as Phase 34, if
  not more so.
  - The single most important design decision this phase makes is
    `callFirstAvailableMethod()` (`module/src/commands/dnd5e.ts`): rather
    than picking one dnd5e roll-method name per action and hoping it matches
    whatever dnd5e version is actually installed — a real risk, since
    PLAN.md's own Phase 35 text says these names "have changed materially
    across dnd5e's 2.x -> 3.x -> 4.x releases" — each roll action tries a
    short list of plausible candidate names in order and calls the first one
    that exists as a function on the actor at runtime. This means the call
    succeeds against whichever dnd5e version is actually connected as long
    as it exposes ANY of the listed names, and fails with a clear,
    diagnosable error naming every candidate tried (pointing at this
    deviation-log entry) rather than a cryptic `TypeError: actor.
    rollAbilityTest is not a function`, if none of them exist. The candidate
    lists used: ability check `["rollAbilityTest", "rollAbilityCheck"]`,
    saving throw `["rollSavingThrow", "rollAbilitySave"]`, skill check
    `["rollSkill"]` (believed stable across versions, so one candidate was
    judged sufficient), death save `["rollDeathSave"]`. `shortRest`/
    `longRest` (the rest action) go through the same existence-check pattern
    inline rather than via the shared helper, since there's exactly one
    candidate per rest type with no ambiguity to resolve.
  - Every roll-action call passes `{fastForward: true, chatMessage: true}` as
    its options argument — `fastForward` skips dnd5e's advantage/
    disadvantage confirmation dialog and rolls immediately (there's no human
    in this headless, API-driven call to click through it), and
    `chatMessage: true` matches Foundry's own default of posting the result
    to chat, so a GM watching the table still sees the API-triggered roll.
    The rest action passes `{dialog: false, chat: true}` to `shortRest()`/
    `longRest()` for the identical headless-context reason (skip the
    rest-configuration dialog, still post to chat).
  - Roll results are normalized via `toRollActionResult()`
    (`module/src/commands/dnd5e.ts`) into the exact same `{formula, total,
    result, dice}` shape Phase 14's plain dice-formula evaluation already
    uses (`RollEvaluateResult`, `shared/src/rolls.ts`) — dnd5e's roll methods
    return a `Roll`/`D20Roll` instance with the identical fields, so this is
    shape reuse, not a new convention. `shared/src/dnd5e.ts`'s
    `Dnd5eRollActionResult` redefines those same three fields inline rather
    than importing `RollEvaluateResult` from `./rolls.ts` — this file already
    has an explicit precedent (its own header comment, from Phase 34) of
    defining its own one-field id input rather than cross-importing
    `ActorIdInput` from `./actors.ts`, and no other shared domain file in
    this codebase cross-imports a type from another one, so introducing the
    first such cross-file type dependency here — for a three-field shape —
    wasn't judged worth breaking that pattern.
  - Spell-slot spend/restore (`dnd5e_adjust_spell_slot`) deliberately does
    NOT call any dnd5e-specific method: there is no stable, documented
    "adjust one spell slot" method in dnd5e's public API — slot spending
    normally happens internally as a side effect of using a spellcasting
    Activity, not as a standalone callable action. Instead it reads and
    writes the actor's own `system.spells.<key>.value` field directly via
    the generic `Document#update()` Phase 8 already proved reliable
    (clamping the result between 0 and the slot's `max`) — a deliberate
    choice to build on already-proven core Foundry API rather than guess at
    a dnd5e method that may not exist.
  - Item use (`dnd5e_use_item`) calls only the item's own top-level `use()`
    method, with no way to target one specific Activity when dnd5e 3.x+'s
    Activities system gives an item several. PLAN.md's own Phase 35 wording
    is "trigger an item/activity use" with no activity-id input in the
    route or request body, so calling the item's own `use()` — which
    internally handles activity selection on dnd5e versions that have
    one — is the faithful, minimal reading of that bullet, consistent with
    this project's running precedent (Phases 16/17/19) of reading a phase's
    own wording narrowly rather than building out every related method. The
    item itself is located generically (`findItemById()`,
    `module/src/commands/dnd5e.ts`): the route is `/dnd5e/items/:id/use`
    with no actor segment, so it searches world items first, then every
    actor's embedded items, matching PLAN.md's own path shape.
  - The rest action's result shape (`dhp`/`newDay` on whatever
    `shortRest()`/`longRest()` resolve with) is dnd5e's own documented but
    version-uncertain convention — both fields are read defensively (`?? 0`/
    `?? false`, with `deltaHitPoints` also falling back to a `deltaHitPoints`
    key in case a version names it differently) rather than assumed present,
    consistent with every field read in Phase 34's own actor-sheet/inventory
    normalization.
  - As with Phase 34, none of Phase 35's module-side handlers have a direct
    unit test (Phase 31's established precedent — they need a real/heavily-
    mocked `game` global); `server/src/integrations/dnd5e/endpoints.test.ts`
    gained one happy-path assertion per new route, extending the same
    fake-`FoundryClient` harness Phase 34 set up rather than building new
    test infrastructure.
- Phase 36 extracted Phases 32-35's structure into
  `server/src/integrations/_template/` (`endpoints.ts`, `index.ts`,
  `README.md`), but kept it entirely out-of-band rather than a real-but-inert
  integration: it's never imported by `server/src/integrations/registry.ts`
  and never referenced by `module.json`, so it can't be mistaken for a
  planned or active integration and never trips `check-manifest-sync.ts`
  (still 1 code / 1 manifest entry, dnd5e only, after this phase). It still
  lives under `server/src/` and typechecks/lints as valid TypeScript, using a
  placeholder `_template` id.
  - Module-side command-handler guidance (the `registerCommand()` /
    defensive-reads / `callFirstAvailableMethod` pattern) is a documented
    checklist step in the README pointing at the real
    `module/src/commands/dnd5e.ts`, not a second unimported file in
    `module/src/commands/` — that directory's files are all real, always-
    imported command modules (`module/src/index.ts`'s flat import list), and
    an unimported placeholder sitting there would read as orphaned dead code.
  - pf2e and "utility modules with a useful public API" are named in the
    README as candidate future integrations, per this phase's own PLAN.md
    text — neither is built.
- Phase 37 is the first phase run against a real, running Foundry V14 Build
  368 instance (`dataPath` a local `C:\dev\FoundryVtt\Data`) with a live
  dnd5e 6.0.3 world (`mcp-test`), closing out the "untested against a live
  instance" caveat every phase since Phase 6 has carried. It found and fixed
  four real bugs, all in the dnd5e integration's write actions (Phase 35) —
  every core-API phase (6–28) and the dnd5e read-only phase (34) worked
  exactly as implemented with zero changes needed:
  - **dnd5e 6.0.3 changed the actor roll methods' call shape, not just their
    names.** `rollAbilityCheck`/`rollSavingThrow`/`rollSkill`/`rollDeathSave`
    now take `(config={}, dialog={}, message={})` config objects instead of
    the `(value, options)` positional args Phase 35 assumed — calling them
    the old way threw `"One of original or other are not Objects!"` from
    inside dnd5e's own `foundry.utils.mergeObject()` (it received a plain
    ability/skill string where it expected an object). Fixed by replacing
    `callFirstAvailableMethod` with `callFirstAvailableRollMethod`
    (`module/src/commands/dnd5e.ts`): for each candidate method name, it
    tries the modern config-object call shape first and falls back to the
    legacy positional shape on failure, rather than assuming a name implies
    a shape (that pairing isn't confidently known to be stable across every
    dnd5e release — `rollSavingThrow`, for instance, may have existed under
    the old positional shape on some pre-6.x version too). `DIALOG_SKIP_CONFIRM
    = {configure: false}` (dnd5e's modern equivalent of the old
    `fastForward: true`) and `MESSAGE_CREATE = {create: true}` are the new
    shared constants passed as the modern shape's `dialog`/`message` args.
  - **`Item#use()` with no dialog config blocks on an interactive dialog.**
    Live-verified: calling a weapon's `use()` with all-default args popped an
    "Attack Roll" configuration dialog (Advantage/Normal/Disadvantage) on the
    GM's client and hung there waiting for a human click — unusable from a
    headless API call. `{configure: false}` in the `dialog` arg (mirroring
    the roll-action fix) suppresses the item's own usage-configuration
    dialog, but NOT this one: `AttackActivity#_triggerSubsequentActions()`
    (dnd5e 6.0.3 source) hardcodes `this.rollAttack({event}, {}, {...})` for
    the automatic follow-up roll after a weapon is used, ignoring whatever
    `dialog` was passed to `use()` entirely — there is no way to suppress it
    through the public API. Fixed by passing `{subsequentActions: false}` in
    the usage config, which skips dnd5e's automatic-follow-up-roll trigger
    altogether: the item is still consumed and its chat card still posted,
    but a caller wanting the actual attack/damage roll needs a separate,
    dedicated roll call — consistent with this endpoint's existing minimal
    scope (no activity-id or roll-target input exists here to configure one
    anyway, per Phase 35's own narrow reading of "trigger an item/activity
    use").
  - **Foundry core's `Combat#endCombat()` always shows an unskippable
    confirmation dialog.** `client/documents/combat.mjs`'s `endCombat()` is
    hardcoded to call `foundry.applications.api.DialogV2.confirm(...)` with
    no option to bypass it, and its own `yes` callback is nothing more than
    `this.delete()` — calling it from a headless API request blocked for the
    full 10s bridge timeout waiting for a GM to click "Yes" in the connected
    client. Fixed by having `COMBAT_COMMANDS.END`
    (`module/src/commands/combats.ts`) call `combat.delete()` directly
    instead of `combat.endCombat()`, achieving the identical effect without
    the dialog. This also changes the endpoint's response shape from the
    (now-deleted, and thus stale) document data to a `DocumentDeleteResult`
    (`{id}`) — matching every other delete-style endpoint's convention —
    so `server/src/endpoints/combats.ts`'s `endDescriptor` and
    `server/src/endpoints/combats.test.ts`'s matching test were both updated
    to the new type/shape.
  - **`dnd5e_roll_initiative` crashes for a combatant with no linked scene
    token** (`Cannot read properties of null (reading 'getGroupingKey')`,
    from `Combatant5e#getGroupingKey()` calling `this.token.getGroupingKey()`
    with no null-check on `this.token`) — reproduced only by adding a
    combatant via a bare `actorId` with no `tokenId`/`sceneId` (which Phase
    16's own `ADD_COMBATANT` command allows). Confirmed this is an edge case
    in dnd5e's own initiative-grouping code, not a bug introduced by this
    project: a combatant added the standard way (from a token already placed
    on a scene, via `tokenId`/`sceneId`) rolls initiative correctly with no
    error. Not fixed in code — `ADD_COMBATANT`'s flexibility (accepting an
    actor-only combatant) is intentional and matches Phase 16's generic
    embedded-document CRUD approach — but documented here as a known
    constraint: initiative rolling on dnd5e requires every combatant in the
    encounter to have a linked scene token.
  - Every other write action re-tested clean with no changes needed:
    `rollAbilityCheck`/`rollSavingThrow`/`rollSkill`/`rollDeathSave` (after
    the shape fix) all produced correct totals and posted matching chat
    cards; `shortRest`/`longRest` completed with no dialog and returned
    correct `dhp`/`newDay` (`dialog: {configure: false}`-equivalent
    `{dialog: false, chat: true}` config Phase 35 already used was already
    correct for rests — only the four D20-roll methods and item-use changed
    shape); spell-slot spend/restore clamped correctly at 0 and at `max`, and
    a long rest correctly refilled a real spellcaster's slots.
  - Also live-verified clean with zero changes: Phase 6 meta endpoints
    (status/world/system/user/users/modules/settings), Phase 8's generic
    document CRUD (actor/item/macro/combat create-update-delete via `data`/
    `changes` body wrapper), Phase 10's embedded actor-items, Phase 12's
    token create/move/visibility-toggle/delete, Phase 14's dice-formula
    evaluation and chat send/list, Phase 15's macro execute (confirmed actual
    arbitrary-JS execution via a real `console.log` reaching the browser
    console), Phase 18's RollTable draw, Phase 20's compendium pack index
    read and import-into-world (both Actor and RollTable packs), Phase 21's
    embedded ActiveEffect create/list/delete, Phase 23's ownership read,
    Phase 26's hook-forwarding-to-`foundry_get_recent_events` pipeline
    (confirmed a real `createItem` hook reaching the polling endpoint),
    Phase 27's search and localization, and Phase 34's dnd5e config/actor-
    sheet/inventory reads (including the documented `skills.<id>.value` →
    `proficient` remapping) — all against the real, current dnd5e 6.0.3, a
    newer major version than the 2.x-4.x range Phases 34/35's original
    deviation-log entries were written against.
  - Getting to a runnable local instance surfaced two setup-only issues
    unrelated to this project's own code, noted here since they'd otherwise
    block any future re-run of this smoke test: the test world's Gamemaster
    user's password had been forgotten with no admin-setup password
    available either. Fixed by stopping the Foundry process and using its
    own `classic-level` dependency (in `App/node_modules`, the same package
    Foundry itself uses for per-world LevelDB storage) to clear then reset
    the user's `password`/`passwordSalt` fields directly in
    `worlds/mcp-test/data/users`' LevelDB store — deleting the fields
    outright isn't enough, since `testPassword()`
    (`App/dist/core/auth.mjs`) calls `crypto.pbkdf2Sync(input, salt, ...)`
    unconditionally and throws (caught, treated as "invalid password") when
    `salt` is `undefined`; the fix instead computes a real
    `hashPassword("", <new random salt>)` pair for a blank password, mirroring
    Foundry's own `hashPassword()` function exactly. Separately, this world
    already had two other, unrelated community modules installed
    ("Foundry API Bridge (Foundry MCP)" and "Foundry REST API") active
    alongside this project's own module — both were deactivated (only this
    project's module was left active) for a clean, non-confounded test run.

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

## Execution Batching (Phases 22–36)

Phases 22–28 are mutually independent domain additions — each owns its own
`shared/`, `server/src/endpoints/`, and `module/src/commands/` files,
following the same self-contained pattern proven in Phases 9–21. They don't
depend on each other's output, but they all register into the same shared
aggregator files (`allEndpointDescriptors`, the MCP registry index,
`foundry-globals.d.ts`), so working them fully in parallel risks merge
conflicts on those files. To keep that manageable, they're batched in chunks
of 3:

- **Batch A:** 22 (Canvas & Scene Placeables), 23 (Permissions & Ownership),
  24 (File/Asset Management)
- **Batch B:** 25 (Users & Client State), 26 (Hooks/Event Streaming), 27
  (Localization & Misc Utilities)
- **Batch C:** 28 (Bulk/Batch & Query Endpoints) — leftover single phase

Phases 29–31 (Security Review, Documentation & Packaging, Test Suite & CI)
run **sequentially, in that order, after Batches A–C all land** — each needs
the full core endpoint surface (all of Phases 8–28) to audit, document, or
test against.

Phases 32–36 (Part 2) form a **strict dependency chain** — 32 → 33 → 34 → 35
→ 36 — and cannot be batched or parallelized: each phase's code requires the
previous phase's code to exist (the integration framework before the
manifest convention, the framework + convention before dnd5e detection, the
dnd5e read-only slice before dnd5e actions, both dnd5e phases before the
template extraction).

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

## Phase 37 — Live Smoke-Test Pass
- Run this project against a real, running Foundry VTT instance (not a
  mocked bridge client) for the first time, closing out the "flagged for a
  live smoke-test whenever a Foundry instance is available" caveat every
  phase since Phase 6 has carried
- Exercise a representative slice of every phase's endpoints end-to-end
  through the real REST API → bridge → live Foundry module → real Foundry/
  dnd5e API, starting with the areas the deviation log flags as riskiest
  (Phase 35's dnd5e write actions, embedded-document phases) and spot-
  checking the rest
- Fix any real bugs found (not documented, accepted deviations) directly in
  the module/server code, add/update tests where a fix changes a
  descriptor's response shape, and re-run the full typecheck/lint/test/
  format suite before considering the phase done
- Leave the test world's data exactly as found when finished (delete any
  fixture actors/items/macros/combats/tokens created for testing)
