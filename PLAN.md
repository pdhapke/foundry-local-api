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
| 22–36 | Not started | — |

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
