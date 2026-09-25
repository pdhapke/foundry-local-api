# Changelog

All notable changes to this project are documented in this file. Format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project has not had a public release yet — see
[README.md's Project status & versioning](./README.md#project-status--versioning).

Entries below are grouped by implementation phase/batch rather than dated
release, since every phase has landed on `main` directly with no tagged
releases so far. Each entry is a summary; **PLAN.md is the source of
truth** for full detail, including the "Deviations from the original plan"
log that documents every non-obvious design decision made along the way.

## [Unreleased]

### Phase 53 — Adventure Document Import/Export
- `foundry_export_adventure` (`POST /api/packs/:packId/adventures`)
  assembles world documents (by id, per content type) into a new Adventure
  compendium entry — the convenience step around hand-composing an
  Adventure's `actors`/`items`/`scenes`/`journal`/`macros`/`tables`/`cards`/
  `playlists`/`folders`/`combats` content fields.
  `foundry_import_adventure` (`POST /api/packs/:packId/adventures/:entryId/
  import`) wraps `Adventure#import()`, bulk-creating/updating documents
  across every world collection the entry's content covers in one call —
  distinct from Phase 20's single-document `foundry_import_pack_entry`.
- Both GM-only; import flagged `destructiveHint: true` (can create or
  overwrite many documents at once).
- Not yet live-verified against a running Foundry world.

### Phase 52 — Digital TableTops Integration (Battlemap Control)
- Second `kind: "module"` integration (dnd5e is `kind: "system"`): detects
  the third-party `digital-tabletops` module and, when active, adds
  `dtt_pan_battlemap` (`POST /api/integrations/digital-tabletops/pan`),
  `dtt_scale_battlemap_to_physical` (`POST /api/integrations/digital-
  tabletops/scale-to-physical`), and a convenience `dtt_get_status`
  (`GET /api/integrations/digital-tabletops/status`) covering module
  active/TV-user online/current settings.
- No new code needed for the module's own `hideUI`/`lockPan`/
  `display-width`/`port-number` world settings — already reachable through
  the existing generic settings endpoints (Phase 7).
- Not yet smoke-tested against a live digital-tabletops session with a real
  or simulated "TV" client.

### Phase 51 — Compendium Pack Lifecycle
- Create/delete/duplicate a compendium pack itself (`POST /api/packs`,
  `DELETE /api/packs/:packId`, `POST /api/packs/:packId/duplicate`) —
  Phase 20 only ever covered CRUD on entries within an already-existing
  pack.
- Pack deletion flagged `destructiveHint: true` with a plain-language
  warning in its tool description (it removes the pack and every entry
  inside it, permanently); all three lifecycle ops are GM-only.

### Phase 30 — Documentation & Packaging
- Full usage README (install/setup, running the server, connecting an MCP
  client, curl + MCP examples, security posture summary).
- OpenAPI 3.1 spec (`docs/openapi.json`) and MCP tool catalog
  (`docs/mcp-tools.md`), both generated from the same endpoint-descriptor
  list that already generates the real REST routes and MCP tools
  (`server/src/scripts/generate-docs.ts`, `npm run generate:docs`).
- `module.json` description filled in; version set to `0.1.0` (pre-release —
  see README); dnd5e `optionalIntegrations`/`relationships.recommends`
  entries marked explicitly as planned/not-yet-implemented (Part 2,
  Phases 32–36, hasn't started).
- This CHANGELOG.

### Phase 29 — Security Review Pass
- Re-audited the full ~100+ endpoint surface against Phase 4's original
  security posture. Found and fixed two real gaps: `SET_OWNERSHIP`/
  `SET_USER_ROLE` (Phase 23) were missing the `requireGM()` gate every
  other privilege-elevating write has; the Phase 24 file-upload body-size
  limit (50mb) had been applied globally instead of scoped to the upload
  route, leaving `/health` and everything else open to large unauthenticated
  request bodies with no rate limiting.
- Everything else — localhost-only bind, API-key auth on `/api/*` and
  `/bridge`, rate limiting, error responses never leaking stack traces,
  the bridge API key never being logged — audited clean.

### Phase 28 — Bulk/Batch & Query Endpoints
- Generic filtered-query endpoint across document collections.
- Batch create/update/delete for cutting round-trips on larger operations.

### Phase 25–27 — Batch B: Users, Events, Localization
- **25 — Users & Client State:** user CRUD (GM only), active/idle status,
  current selection/targeting.
- **26 — Hooks/Event Streaming:** the module subscribes to Foundry hooks
  and pushes them to the server; exposed as `GET /api/events` (Server-Sent
  Events) plus a polling MCP tool (SSE has no MCP equivalent).
- **27 — Localization & Misc Utilities:** `GET /api/localize`, HTML
  enrichment, in-world search.

### Phase 22–24 — Batch A: Canvas, Permissions, Files
- **22 — Canvas & Scene Placeables:** Drawing/Note/AmbientLight/
  AmbientSound/Wall/MeasuredTemplate CRUD, camera pan/zoom.
- **23 — Permissions & Ownership:** get/set document ownership, world
  permission levels per user.
- **24 — File/Asset Management:** browse `FilePicker` directories, upload
  files, create directories — a thin pass-through to Foundry's own upload
  security model.

### Phase 9–21 — Document Domains
Actors, Items (world + embedded actor-items), Scenes, Tokens
(scene-embedded), Journal Entries & Pages, Dice Rolling & Chat Messages,
Macros (with an explicit `destructiveHint` safety annotation on execution),
Combat & Combat Tracker, Playlists & Audio, RollTables & Cards, Folders,
Compendium Packs, Active Effects. Most of these reuse one generic
`makeDocumentEndpoints()` factory (introduced in Phase 8) for base CRUD and
layer hand-rolled "extras" (roll data, move/visibility, start/next-turn,
play/pause, execute, etc.) on top per document type.

### Phase 0–8 — Core Scaffold
- Repo/tooling foundation: npm workspaces (`server`/`module`/`shared`),
  strict TypeScript, ESLint + Prettier.
- Base Express server scaffold with `.env`-based config, localhost-only bind
  by default, graceful shutdown.
- Foundry module bridge client (WebSocket) and the server-side WS gateway.
- **Security Hardening Pass 1:** auto-provisioned API key on `/api/*` and
  `/bridge`, closing a bridge-hijack gap the initial WS gateway had left
  open.
- MCP server interface scaffold (stdio transport, gated by `MCP_STDIO`).
- Core meta/introspection endpoints (status, world, system, user(s),
  modules, settings list) — the first full vertical slice, and the origin
  of the endpoint-descriptor pattern every later phase reuses.
- Settings read/write, with GM-only gating for world-scope settings
  enforced module-side.
- Generic Document CRUD core (`makeDocumentEndpoints()`), proven first
  against `JournalEntry`.
