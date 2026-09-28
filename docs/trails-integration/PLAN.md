# Trails of Destiny optional integration implementation plan

**Planning status:** COMPLETE (2026-09-26)
**Implementation status:** COMPLETE (2026-09-26)
**Authoritative inputs:** `trails-system-audit.md`, `server-architecture-audit.md`
**Completion rule:** This project is complete only when every required task in Phases 1-7 is checked, the final verification matrix passes, and the progress log records the evidence. Deferred work is not part of completion.

## Status and execution rules

- `[ ]` not started; `[~]` in progress; `[x]` complete; `[!]` blocked.
- One task is the unit of assignment to one subagent. An agent must read this file and its task's named inputs, limit edits to the named files unless the progress log explains a necessary deviation, run the task's focused tests, update its checkbox and append a progress-log entry.
- Phase dependencies are gates. Tasks within a phase may run in parallel only when they do not name the same files. The final agent for each phase integrates concurrent edits and runs the phase acceptance checks.
- Preserve the existing dirty working tree. Before editing, record relevant pre-existing changes with `git status --short` from the actual repository root; never reset or overwrite unrelated work.
- All public operations use one `EndpointDescriptor` for REST and MCP. Do not build separate Trails REST and MCP business logic.
- Module command files are imported in every world. They must not import Trails modules or dereference `CONFIG.TRAILS` at module evaluation time. Resolve capabilities inside handlers and fail clearly when unavailable.

## Architecture decisions (fixed for this implementation)

1. **Exact optional identity.** The integration id and REST namespace are `trails-of-destiny`; detection is `activeSystemId === "trails-of-destiny"`. REST routes live under `/api/integrations/trails-of-destiny/...`. Set `kind: "system"` and `minVersion: "0.1.0"`; do not set an upper bound while the API is pre-1.0.
2. **Safe MCP prefix.** Add an optional `toolPrefix` to `Integration`, defaulting to `${id}_`. Trails sets `toolPrefix: "trails_"`. Validate that each descriptor name starts with the effective prefix. This preserves the exact package id while producing portable tools such as `trails_get_config`.
3. **Transport parity is prerequisite work.** An active optional integration must expose the same tools through in-process stdio (`MCP_STDIO=true`), Streamable HTTP (`/mcp`), and forwarding/remote stdio (`mcp-remote`). Inactive integrations must be absent from all three catalogs; REST continues to return `INTEGRATION_INACTIVE` for its registered namespace.
4. **Per-server MCP state.** Dynamic tool handles are tracked per `McpServer` (a `WeakMap`, not the current process-global id map). Each Streamable HTTP session gets an initial active snapshot, subscribes to manager changes, and unsubscribes/cleans up on close. One session must never suppress or remove another session's tools.
5. **Remote stdio synchronization.** The forwarding server uses the same registry and active-system/module detection policy as the main server. It refreshes its active snapshot from authenticated `/api/system` and `/api/modules`, registers/removes integration tools per its own MCP server, and emits `tools/list_changed` only on a real change. Forwarded integration descriptors target `/api/integrations${descriptor.path}` rather than `/api${descriptor.path}`. A bounded polling lifecycle is acceptable because remote stdio has no integration-change push channel; stop the timer on shutdown and retain the last known catalog on transient refresh failure.
6. **Bounded first release.** Required Trails operations are read-only document/catalog views, pure random roll resolution, and pure previews. No endpoint mutates an Actor, Item, Combat, resource, chat, or builder state. Actor creation/import, gameplay application, resource edits, and “roll and post” are deferred until persisted idempotency journals and atomic adapters exist.
7. **Capability source.** Runtime operations call the public namespaces installed at `CONFIG.TRAILS.creation`, `.gameplay`, and `.builder`. Version/config responses distinguish package version (`game.system.version`), persisted rules version (`CONFIG.TRAILS.RULES_VERSION` or live actor evidence), and `gameplay.GAMEPLAY_RULES_VERSION`; never synthesize one from another.
8. **Permissions and redaction.** Actor operations require normal document visibility (at least OBSERVER, or GM); catalog operations require an accessible pack. Responses omit biography, campaign notes, adjudications, `creation.sourceSnapshot`, recorded builder/selection evidence, secrets, and raw document dumps. Inventory preserves `_id`, `catalogId`, and `instanceId` as separate identities and never deduplicates by catalog id.
9. **Boundary-preserving contracts.** Return system results without deleting `boundary`, `manualBoundary`, `issues`, `unmapped`, `source`, status, or readiness findings. Every preview response includes package/rules contract versions where available. Descriptions must say that previews/roll evidence do not apply state.
10. **No caller-supplied dice for actual rolls.** `trails_roll_action` and `trails_preview_initiative` use the Trails runtime RNG. Deterministic injection exists only in Trails' own unit tests or module-handler tests. Recovery preview accepts recorded dice because that API explicitly models evidence and remains non-authoritative.

## Required public surface

| Tool | REST route | Behavior |
|---|---|---|
| `trails_get_config` | `GET /config` | Package/rules/gameplay versions, abilities, item types, damage types, die ranks, threat classifications, catalog descriptors, and capability booleans. |
| `trails_get_actor_sheet` | `GET /actors/:id/sheet` | Redacted prepared actor summary, defenses/actions/resources/movement/capacity/currency, schema/rules evidence, readiness findings. |
| `trails_get_actor_inventory` | `GET /actors/:id/inventory` | All embedded items with three identities, provenance/citation/status, and type-specific fields; no deduplication. |
| `trails_list_catalogs` | `GET /catalogs` | Known pack ids/labels, accessibility, and safe entry counts. |
| `trails_get_catalog` | `GET /catalogs/:packId` | Sanitized canonical entries from one allowlisted Trails pack, addressed by `catalogId`; no UUID-as-identity contract. |
| `trails_evaluate_creation` | `GET /actors/:id/creation-readiness` | Calls `creation.evaluateCreation` from a redacted actor/item snapshot plus runtime catalogs; returns findings/boundaries only. |
| `trails_roll_action` | `POST /rolls/action` | Calls `gameplay.resolveActionRoll`; produces random roll evidence only, with no chat/resource/document changes. |
| `trails_preview_initiative` | `POST /previews/initiative` | Calls `gameplay.previewInitiative`; no Combat writes; ties remain manual. |
| `trails_preview_threat_contest` | `POST /previews/threat-contest` | Calls `gameplay.previewThreatContest`; no reaction cost/damage application. |
| `trails_preview_damage` | `POST /previews/damage` | Calls `gameplay.previewPostMitigationDamage`; input is already-adjudicated post-mitigation damage. |
| `trails_preview_recovery` | `POST /previews/recovery` | Calls `gameplay.buildRecoveryPlan`; preserves unverified claims and manual boundary. |
| `trails_get_experience_progress` | `GET /experience/:totalExperience` | Calls `gameplay.experienceProgress`; never extrapolates beyond the published table. |
| `trails_preview_builder` | `POST /builder/preview` | Calls `creation.parseBuilderV1`, `validateBuilderV1`, and `previewBuilderV1`; enforces 2 MB request limit and returns `issues` plus `unmapped`; no create/reconcile write. |

The descriptor paths above are relative to `/api/integrations/trails-of-destiny`. All schemas remain flat Zod objects; object/list values belong in POST bodies, not nested GET query serialization.

## Phase 0 — Audit and plan

- [x] **P0-T1: Audit the Trails system.** Output: `docs/trails-integration/trails-system-audit.md`.
- [x] **P0-T2: Audit server/integration/MCP architecture.** Output: `docs/trails-integration/server-architecture-audit.md`.
- [x] **P0-T3: Produce this authoritative implementation plan.** No implementation code changed.

**Phase 0 acceptance:** audits identify system id/APIs/security boundaries and server transport gap; this plan fixes scope and sequencing. **Status: COMPLETE.**

## Phase 1 — Optional-integration and MCP transport foundation

**Depends on:** Phase 0. Trails feature work must not register until this phase passes.

- [x] **P1-T1: Separate integration identity from MCP tool prefix and validate descriptors.**
  Files/symbols: `server/src/integrations/types.ts` (`Integration.toolPrefix` and effective-prefix helper), `server/src/integrations/registry.ts` or a new narrowly scoped validator, `server/src/integrations/_template/README.md`, associated tests.
  Acceptance: existing dnd5e/digital-tabletops registrations remain valid by default; a hyphenated id with `toolPrefix: "trails_"` accepts `trails_*`; duplicate tool names, invalid prefixes, and prefix mismatches fail deterministically before serving tools.

- [x] **P1-T2: Make dynamic MCP tool tracking per server and disposable.**
  Files/symbols: `server/src/integrations/mcp-tools.ts` (`trackedTools`, `applyActiveIntegrationTools`, new cleanup/bind helper), `server/src/integrations/mcp-tools.test.ts`.
  Acceptance: two fake `McpServer` instances can register the same integration independently; deactivation on one does not affect the other; repeated snapshots are no-ops; cleanup removes only that server's tools; exactly one `tools/list_changed` is sent per real post-initialization change.

- [x] **P1-T3: Give every in-process MCP server an active snapshot and lifecycle subscription.**
  Depends on: P1-T2. Files/symbols: `server/src/mcp/create-mcp-server.ts`, `server/src/mcp/index.ts`, `server/src/mcp/http-transport.ts` (`McpHttpOptions`, session creation/close), `server/src/app.ts` (`CreateAppOptions.mcp`), `server/src/index.ts`. Add `server/src/mcp/http-transport.test.ts` if absent.
  Acceptance: in-process stdio and every HTTP session list an already-active integration at initialization; later activation/deactivation changes every live session and notifies it; closing one session unsubscribes it; core tools remain unchanged.

- [x] **P1-T4: Add optional integrations to forwarding/remote stdio MCP.**
  Depends on: P1-T1, P1-T2. Files/symbols: `server/src/mcp/create-http-mcp-server.ts`, `server/src/mcp/http-tool-client.ts` (`callRestEndpoint`/route base selection), `server/src/mcp-remote.ts`, optional pure active-detection extraction from `server/src/integrations/manager.ts`, new focused tests for the HTTP forwarding client/server.
  Acceptance: remote stdio initially registers only integrations detected from `/api/system` and `/api/modules`; integration calls use `/api/integrations/trails-of-destiny/...`; a changed snapshot adds/removes tools and notifies; auth is sent; timer/errors/shutdown do not leak or erase the last good catalog.

- [x] **P1-T5: Phase integration and regression verification.**
  Depends on: P1-T1..T4. Run server focused tests, typecheck, and lint. Record any pre-existing failures separately.
  Acceptance: a transport matrix test proves one fake optional descriptor is listable and callable over in-process stdio registration, a Streamable HTTP session, and remote HTTP forwarding, then absent after deactivation; REST inactive behavior remains covered by `integrations/router.test.ts`.

## Phase 2 — Shared Trails contracts and optional registration

**Depends on:** Phase 1.

- [x] **P2-T1: Define shared commands and DTOs.**
  Files/symbols: new `shared/src/trails-of-destiny.ts` (`TRAILS_COMMANDS`, input/result interfaces for every required operation), `shared/src/index.ts`, `shared/src/commands.test.ts`.
  Acceptance: command values are unique and namespaced (for example `trails-of-destiny.get-config`); DTOs distinguish package/rules/gameplay versions, preserve boundary fields, represent item identities separately, and contain no Foundry document classes or `any`-shaped public result.

- [x] **P2-T2: Create Trails descriptor schemas and integration metadata.**
  Depends on: P2-T1. Files/symbols: new `server/src/integrations/trails-of-destiny/index.ts`, new `server/src/integrations/trails-of-destiny/endpoints.ts`.
  Acceptance: integration uses exact id/detection/minVersion and `toolPrefix: "trails_"`; every required operation has one descriptor, flat bounded Zod validation, correct HTTP verb/path, and honest read-only/non-destructive descriptions and annotations; no descriptor is registered globally yet.

## Phase 3 — Foundry module read handlers

**Depends on:** Phase 2. Tasks P3-T1..T4 may be split between agents only if a phase integrator resolves their shared command file deliberately.

- [x] **P3-T1: Build safe capability, permission, and redaction helpers.**
  Files/symbols: new `module/src/commands/trails-of-destiny.ts` internal helpers such as `requireTrailsCapability`, actor lookup/visibility check, pack allowlist/access check, safe clone/redaction, and actionable error conversion.
  Acceptance: importing the module in a non-Trails world has no Trails dependency/global access; absent namespace/function returns a clear capability error; unauthorized/missing actors and inaccessible packs reveal no protected data; helpers never return raw `sourceSnapshot`/biography/campaign notes/adjudications.

- [x] **P3-T2: Implement config and actor-sheet command handlers.**
  Depends on: P3-T1. Files/symbols: `module/src/commands/trails-of-destiny.ts` registrations for `TRAILS_COMMANDS.CONFIG` and `.ACTOR_SHEET`.
  Acceptance: config reflects live `CONFIG.TRAILS` and reports distinct versions/capability flags; actor sheet uses prepared live values without persisting derived fields, supports `character` and `npc`, enforces visibility, includes readiness evidence, and passes fixture tests for missing optional fields and redaction.

- [x] **P3-T3: Implement inventory and catalog command handlers.**
  Depends on: P3-T1. Files/symbols: same command file; use `CONFIG.TRAILS` plus the verified catalog integration API (`loadRuntimeCatalogContext`/pack descriptors) only at call time.
  Acceptance: duplicate `catalogId` owned items remain separate; `_id`, `catalogId`, `instanceId`, origin/citation/status and type-specific data survive; catalog lookup is limited to the four declared packs, returns sanitized canonical records/counts, respects pack access, and does not promise UUID portability.

- [x] **P3-T4: Implement creation-readiness command handler.**
  Depends on: P3-T1, P3-T3. Files/symbols: registration for `TRAILS_COMMANDS.EVALUATE_CREATION`; call live `CONFIG.TRAILS.creation.evaluateCreation`.
  Acceptance: visible actor/item/catalog snapshots are passed without sensitive builder evidence; findings, `issues`, `unmapped`, statuses, sources, and manual boundaries survive unchanged; handler performs no updates.

- [x] **P3-T5: Wire and test module handlers.**
  Depends on: P3-T2..T4. Files/symbols: `module/src/index.ts` side-effect import; new focused module test(s) with minimal Foundry globals if practical, otherwise extracted pure helper tests plus a recorded live-smoke requirement.
  Acceptance: non-Trails import succeeds; all command names register exactly once; shared/module typecheck passes.

## Phase 4 — Pure roll and domain-preview handlers

**Depends on:** P2-T1, P3-T1.

- [x] **P4-T1: Implement action roll and initiative preview.**
  Files/symbols: `module/src/commands/trails-of-destiny.ts`; `TRAILS_COMMANDS.ROLL_ACTION`, `.PREVIEW_INITIATIVE`; call `CONFIG.TRAILS.gameplay.resolveActionRoll` and `.previewInitiative` with runtime RNG (no injected caller rolls).
  Acceptance: schemas enforce Trails' integer/range limits; returned action/bonus dice, totals, source, contract version, ties and boundary are lossless; no Actor/Combat/chat/resource mutation occurs.

- [x] **P4-T2: Implement threat and damage previews.**
  Files/symbols: same command file; call `previewThreatContest` and `previewPostMitigationDamage`.
  Acceptance: classification is `attack|assault`; nonnegative integer validation matches the system; damage is explicitly post-mitigation; shock/death/manual-review findings and boundary survive; no application occurs.

- [x] **P4-T3: Implement recovery and experience previews.**
  Files/symbols: same command file; call `buildRecoveryPlan` and `experienceProgress`.
  Acceptance: recovery requires explicit eligibility for all five resources and bounded recorded dice arrays, retains unverified daily claims/manual boundary, and never applies operations; EXP rejects negative/non-integer totals and reports published-table exhaustion without extrapolation.

- [x] **P4-T4: Focused domain-handler tests.**
  Depends on: P4-T1..T3. Files: new/existing module command tests.
  Acceptance: prove capability dispatch, input passthrough, output preservation, runtime RNG ownership, error propagation, and zero Foundry document update/chat calls.

## Phase 5 — Builder preview (no persistence)

**Depends on:** P3-T1, P3-T3.

- [x] **P5-T1: Implement builder parse/validate/preview handler.**
  Files/symbols: `module/src/commands/trails-of-destiny.ts`; call `CONFIG.TRAILS.creation.parseBuilderV1`, `.validateBuilderV1`, and `.previewBuilderV1` with runtime catalogs.
  Acceptance: accepts raw JSON text only within the server's 2 MB default body limit; malformed/oversized input fails clearly; `issues` and `unmapped` are always returned; no `createFoundryActor`, builder request execution, reconciliation, identity generation, or document mutation occurs.

- [x] **P5-T2: Builder boundary tests.**
  Depends on: P5-T1. Files: module handler tests and server descriptor validation tests as appropriate.
  Acceptance: valid, invalid, unmapped, and near-limit inputs are covered; an empty issue list is described/tested as preview success, not authorization to persist.

## Phase 6 — Descriptor routing and end-to-end contract tests

**Depends on:** Phases 2-5.

- [x] **P6-T1: Declare and register the optional system atomically.**
  Files/symbols: `server/src/integrations/registry.ts`, root `module.json` (`relationships.recommends`, `flags["foundry-local-api"].optionalIntegrations`), `server/src/scripts/check-manifest-sync.test.ts` if the new `toolPrefix` needs sync coverage. If packaging creates a second generated/copy manifest, update it through the existing build process rather than hand-maintaining an unverified path.
  Acceptance: Trails is optional, core APIs start without the system installed, manifest sync passes, inactive REST returns `INTEGRATION_INACTIVE`, and inactive MCP catalogs omit every `trails_*` tool.

- [x] **P6-T2: Test every Trails descriptor's REST-to-bridge mapping.**
  Files: new `server/src/integrations/trails-of-destiny/endpoints.test.ts`, modeled on dnd5e's fake `FoundryClient` harness.
  Acceptance: one happy path per route plus representative invalid ids/enums/bounds/body shapes; assertions cover exact command and payload; GET path parameters merge correctly; POST objects/lists remain body fields.

- [x] **P6-T3: Test activation, prefix, and all MCP transports with real Trails descriptors.**
  Files: `server/src/integrations/manager.test.ts`, `router.test.ts`, `mcp-tools.test.ts`, `server/src/mcp/http-transport.test.ts`, forwarding-client tests.
  Acceptance: system id `trails-of-destiny` and version >=0.1.0 activates; wrong id/older version does not; REST namespace and `trails_*` MCP prefix are exact; each transport lists/calls the same Trails tool set; multiple HTTP sessions remain independent; deactivation removes/notifies everywhere.

- [x] **P6-T4: Security/redaction contract tests.**
  Files: module Trails tests and/or shared fixtures.
  Acceptance: observer/owner/GM allowed cases and unauthorized cases are explicit; sensitive fields and raw snapshots never appear; duplicate catalog ids remain distinct; manual/reference boundaries and version fields survive bridge serialization.

## Phase 7 — Documentation, live smoke test, and release gate

**Depends on:** Phase 6.

- [x] **P7-T1: Regenerate and review public docs.**
  Files/symbols: `server/src/scripts/generate-docs.ts` if total/count or `toolPrefix` rendering needs correction; generated `docs/openapi.json`, `docs/mcp-tools.md`; optional integration docs/README.
  Commands: `npm run generate:docs --workspace=server`, then repository formatter.
  Acceptance: all Trails REST operations carry `x-integration` with exact id/kind; all 13 MCP tools appear as `trails_*`; totals include integration tools; descriptions state preview/manual boundaries and inactivity behavior; all three MCP transports are documented without overstating mutation support.

- [x] **P7-T2: Live Trails world smoke test.**
  Preconditions: Foundry 14 world using installed `trails-of-destiny` >=0.1.0 and an authorized bridge user. Record system/package versions and redact private world data from logs.
  Acceptance: verify config, one permitted actor sheet/inventory/readiness, catalog list/lookup, action roll, each preview family, and builder preview over REST; verify the identical tool set/calls via in-process stdio, Streamable HTTP, and remote stdio; verify a non-Trails world has core functionality, inactive REST error, and no Trails MCP tools; verify unauthorized actor/pack access fails.

- [x] **P7-T3: Full repository verification and completion audit.**
  Commands from the `foundry-local-api` repository root: `npm run generate:docs`, `npm run check-manifest-sync`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build`.
  Acceptance: all commands pass, or any confirmed pre-existing failure is documented with reproduction and the Trails diff is proven clean of causation. Review every required checkbox and progress entry, confirm no write endpoints slipped in, then set **Implementation status** above to `COMPLETE`.

## Explicitly deferred (not required for this plan's completion)

- Actor creation/import using `prepareFoundryImport` + `createFoundryActor`.
- Builder create/reconcile persistence and companion mounting.
- Resource/damage/recovery/gameplay mutations through `executeGameplayRequest`.
- “Roll and post” chat actions, Combat initiative writes, condition/timer automation.
- Generic actor/item field edits.

These require a persistent production journal, requester authorization, revision checks, approved plans, idempotency, atomic document/chat commits, rollback tests, and explicit destructive MCP annotations. The in-memory `GameplayRequestJournal`/`BuilderRequestJournal` are test/reference implementations and must not be treated as production authority.

## Final verification matrix

| Concern | Required evidence |
|---|---|
| Optional activation | Manager tests for exact id/version; non-Trails live smoke. |
| REST | Active success and inactive `INTEGRATION_INACTIVE`; descriptor mapping tests. |
| In-process stdio MCP | Active list/call, dynamic removal notification. |
| Streamable HTTP MCP | Two independent sessions, active list/call, dynamic removal and cleanup. |
| Remote stdio MCP | Authenticated metadata refresh, integration route prefix, list/call/removal, timer shutdown. |
| Permissions/redaction | Actor and pack access cases; sensitive-field absence assertions. |
| Identity | `_id`/`catalogId`/`instanceId` retained; duplicate catalog ids retained. |
| Rule boundaries | Version/source/issues/unmapped/boundary/manualBoundary preserved. |
| No writes | Spies/live checks show no document, Combat, chat, or resource mutation. |
| Packaging/docs | Manifest sync, generated OpenAPI/MCP docs, build. |

## Progress log

Append one concise entry per completed/blocked task. Link to test output or name the exact command; do not paste large logs.

| Date | Task | Status | Agent | Files/results | Verification / notes |
|---|---|---|---|---|---|
| 2026-09-26 | P0-T1 | complete | audit agent | `trails-system-audit.md` | System id, public namespaces, documents, risks, and candidate surface recorded. |
| 2026-09-26 | P0-T2 | complete | audit agent | `server-architecture-audit.md` | REST/bridge/integration seams and MCP transport parity gap recorded. |
| 2026-09-26 | P0-T3 | complete | planning agent | `PLAN.md` | Ordered implementation tasks, architecture decisions, acceptance gates, and bounded scope recorded; no code implemented. |
| 2026-09-26 | P1-T2 | complete | implementation agent | `server/src/integrations/mcp-tools.ts`, `server/src/integrations/mcp-tools.test.ts` | Per-server `WeakMap`, bind/dispose lifecycle, and notification semantics implemented; server tests (279/279), server typecheck, targeted lint/format checks passed. |
| 2026-09-26 | P1-T1 | complete | implementation agent | `server/src/integrations/{types.ts,registry.ts,registry.test.ts,digital-tabletops/index.ts,_template/{README.md,index.ts,endpoints.ts}}` | Added explicit/default MCP prefixes and startup registry validation; focused tests (5/5), server suite (284/284), server typecheck, targeted lint/format checks passed. |
| 2026-09-26 | P1-T4 | complete | implementation agent | `server/src/mcp/{create-http-mcp-server.ts,http-tool-client.ts}`, `server/src/mcp-remote.ts`, `server/src/integrations/manager.ts`, focused tests | Added authenticated active-catalog discovery, shared detection/version policy, integration REST forwarding, serialized bounded polling, last-good retention, dynamic notifications, and shutdown disposal; focused tests (20/20), server suite (289/289), server typecheck, targeted lint/format checks passed. |
| 2026-09-26 | P1-T3 | complete | implementation agent | `server/src/mcp/{create-mcp-server.ts,index.ts,http-transport.ts}`, `server/src/{app.ts,index.ts}`, focused lifecycle tests | In-process stdio/shared factory and each HTTP session now snapshot and subscribe independently, notify on changes, and unsubscribe/clean up on close; focused tests (2/2), server suite (290/290), server typecheck, targeted lint/format checks passed. |
| 2026-09-26 | P1-T5 | complete | verification agent | `server/src/mcp/transport-matrix.test.ts`; Phase 1 gate | One fake optional descriptor is listable/callable then removable over in-process stdio registration, Streamable HTTP, and remote HTTP forwarding; REST inactive regression retained. Focused tests 32/32, full workspace tests 316/316, typecheck, lint, format, and diff checks passed. |
| 2026-09-26 | P2-T1 | complete | contract agent | `shared/src/trails-of-destiny.ts`, `shared/src/index.ts`, `shared/src/commands.test.ts` | Added 13 namespaced commands and serializable typed DTOs with distinct versions, boundary evidence, and separate item identities; full workspace tests (317/317), typecheck, targeted lint/format, and diff checks passed. |
| 2026-09-26 | P2-T2 | complete | descriptor agent | `server/src/integrations/trails-of-destiny/{index.ts,endpoints.ts,endpoints.metadata.test.ts}` | Added unregistered exact system metadata and 13 read-only/non-destructive REST/MCP descriptors with flat bounded schemas; focused tests 4/4, server suite 295/295, server typecheck, targeted lint/format, and diff checks passed. |
| 2026-09-26 | P3-T1 | complete | module foundation agent | `module/src/commands/trails-of-destiny{.ts,.test.ts}` | Added lazy capability resolution, fail-closed actor/pack visibility checks, catalog allowlist, recursive sensitive-data redaction, and safe actionable errors; module tests 27/27, module typecheck, targeted lint/format checks passed. |
| 2026-09-26 | P3-T2 | complete | config/actor agent | `module/src/commands/trails-of-destiny{.ts,.test.ts}` | Registered config and actor-sheet reads with live distinct versions/capabilities, prepared character/npc values, fail-closed visibility, exact redacted readiness DTOs, and sparse-fixture defaults; module tests 30/30, module typecheck, targeted lint/format checks passed. |
| 2026-09-26 | P3-T3 | complete | inventory/catalog agent | `module/src/commands/trails-of-destiny{.ts,.test.ts}` | Added duplicate-preserving owned inventory projections for all six Item types plus lazy allowlisted, access-checked runtime catalog reads with sanitized canonical records/counts and no UUID identity; module tests 34/34, module typecheck, targeted lint/format checks passed. |
| 2026-09-26 | P3-T4 | complete | creation-readiness agent | `module/src/commands/trails-of-destiny{.ts,.test.ts}` | Registered live creation evaluation over visible allowlisted/redacted Actor, Item, and catalog snapshots; preserved lane findings/status/source/issues/manual boundaries and unmapped readiness evidence with no writes; module tests 36/36, module typecheck, targeted lint/format checks passed. |
| 2026-09-26 | P3-T5 / Phase 3 gate | complete | module wiring agent | `module/src/{index.ts,index.test.ts,command-registry.ts}` | Wired the lazy Trails handler import and proved a non-Trails entrypoint import succeeds while all six Phase 3 commands register exactly once; focused tests 2/2, module suite 38/38, shared/module typechecks, targeted lint/format, and scoped diff checks passed. |
| 2026-09-26 | P4-T1 | complete | roll/initiative agent | `module/src/commands/trails-of-destiny{.ts,.test.ts}` | Registered live action-roll and initiative-preview dispatch with runtime-owned RNG, lossless safe result evidence plus version fields, and no Foundry writes; module suite 40/40, shared/module typechecks, targeted lint/format checks passed. |
| 2026-09-26 | P4-T2 | complete | threat/damage agent | `module/src/commands/trails-of-destiny{.ts,.test.ts}`, `server/src/integrations/trails-of-destiny/endpoints.metadata.test.ts` | Registered live attack/assault contest and post-mitigation damage preview dispatch; preserved tie, shock/death/manual-review evidence and no-application boundaries; module suite 42/42, focused descriptor tests 5/5, module/server typechecks, targeted lint/format checks passed. |
| 2026-09-26 | P4-T3 | complete | recovery/experience agent | `module/src/commands/trails-of-destiny{.ts,.test.ts}` | Registered live recovery-plan and experience-progress dispatch; preserved explicit five-resource eligibility, bounded recorded-dice/domain failures, unverified daily claims/manual boundary, and published-table exhaustion with no operations applied or thresholds extrapolated; module suite 45/45, module typecheck, targeted lint/format checks passed. |
| 2026-09-26 | P4-T4 / Phase 4 gate | complete | domain-handler verification agent | `module/src/commands/trails-of-destiny.test.ts` | Proved all six domain handlers dispatch to the live capability with exact inputs, preserve system evidence and versions, keep action/initiative RNG runtime-owned, convert runtime failures to operation-specific actionable redacted errors, and make zero Actor/Combat/chat/resource writes. Module suite 46/46, shared suite 5/5, Trails descriptor suite 5/5, module/shared/server typechecks, targeted lint/format, and scoped diff checks passed. |
| 2026-09-26 | P5-T1 | complete | builder-preview agent | `module/src/commands/trails-of-destiny{.ts,.test.ts}` | Added live creation parse/validate/preview dispatch with visible runtime catalogs, safe DTO projection, stable issues/unmapped arrays, clear malformed JSON diagnostics, and an explicit no-persistence/execution/reconciliation/identity/document-mutation boundary. Module suite 48/48, module typecheck, Trails descriptor suite 5/5, targeted lint/format checks passed. |
| 2026-09-26 | P5-T2 / Phase 5 gate | complete | builder-boundary verification agent | `module/src/commands/trails-of-destiny.test.ts`, `server/src/integrations/trails-of-destiny/{endpoints.ts,endpoints.metadata.test.ts}` | Covered valid issue-free, invalid, unmapped, malformed, near-2 MB, ASCII-oversized, and multibyte-oversized builder inputs; made the descriptor limit UTF-8-byte accurate; proved empty issues mean preview success only and all persistence/execution/reconciliation/identity/document mutation spies remain untouched. Module 50/50, server 296/296, full workspace 351/351, typecheck, lint (0 errors; 7 pre-existing warnings), format, and diff checks passed; the previously observed HTTP timeout did not recur. |
| 2026-09-26 | P6-T1 | complete | optional-registration agent | `server/src/integrations/{registry.ts,manager.test.ts,router.test.ts,mcp-tools.test.ts,trails-of-destiny/endpoints.metadata.test.ts}`, `module.json` | Atomically registered Trails as an optional system and declared its Foundry recommendation/loader metadata; proved non-Trails detection stays inactive, REST returns `INTEGRATION_INACTIVE`, and all 13 `trails_*` tools are omitted while inactive. Manifest sync (3/3), server tests 299/299, server typecheck, targeted lint/format, and scoped diff checks passed. |
| 2026-09-26 | P6-T2 | complete | REST mapping agent | `server/src/integrations/trails-of-destiny/endpoints.test.ts` | Covered all 13 REST routes with exact bridge command/payload assertions, GET path merge/coercion, nested POST object/list preservation, and representative id/enum/bound/body-shape rejection. Focused suite 31/31, server suite 333/333, server typecheck, targeted lint/format checks passed; no descriptor defects found. |
| 2026-09-26 | P6-T4 | complete | security/redaction agent | `module/src/commands/trails-of-destiny{.ts,.test.ts}` | Added explicit observer/owner/GM/unauthorized actor and pack bridge contracts; proved sensitive/raw snapshots are absent, duplicate catalog identities and manual/reference/version evidence survive JSON bridge serialization; fixed `rawSnapshot` redaction. Module 52/52 and shared 5/5 tests, both typechecks, targeted lint/format, and scoped diff checks passed. |
| 2026-09-26 | P6-T3 / Phase 6 gate | complete | transport verification agent | `server/src/integrations/{manager.test.ts,router.test.ts,mcp-tools.test.ts}`, `server/src/mcp/{create-http-mcp-server.test.ts,http-transport.test.ts,transport-matrix.test.ts}` | Proved exact Trails id/min-version activation, REST namespace and 13-tool `trails_*` prefix, full list/call/removal parity across in-process, Streamable HTTP, and remote forwarding, independent HTTP sessions, authenticated remote routing, and deactivation notifications. Focused checks, server typecheck/lint/format, and full server suite 333/333 passed; no transport defect found. |
| 2026-09-26 | P7-T1 | complete | documentation agent | `server/src/scripts/generate-docs.ts`, `docs/{openapi.json,mcp-tools.md}`, `README.md` | Regenerated public docs with 225 total tools (198 core + 27 optional), all 13 `trails_*` tools and exact Trails `x-integration` metadata; documented inactivity, preview/manual/no-mutation boundaries, and all three MCP transports. Docs assertions, metadata tests 5/5, server typecheck, targeted lint/format, and diff check passed. |
| 2026-09-26 | P7-T2 | blocked | live-smoke agent | `scripts/trails-live-smoke.mjs`; local Foundry worlds `trails-testing` and `mcp-test` | Rebuilt stale runtime artifacts, then live-tested Foundry 14.368, Trails 0.1.0, module 0.1.0/server 0.0.1 on Node 24.15.0 with a temporary loopback-only API process/key (key never logged). Active Trails: all 13 REST operations passed, including config, actor sheet/inventory/readiness, all roll/preview families, catalog list/read, experience, and builder; missing/wrong auth returned 401; actor redaction assertions passed. The same 13-tool catalog and every call passed over Streamable HTTP, remote stdio, and in-process stdio. A live dnd5e 6.0.3 world retained core status, returned 404 `INTEGRATION_INACTIVE`, and omitted all Trails tools on all three MCP transports. A temporary restricted player was created: unauthorized actor read was rejected with no data; all temporary actors/users were deleted, temporary servers stopped, client bridge URL/key restored, and the original `mcp-test` dnd5e world was relaunched and verified at its join page. The harness and plan pass Prettier/check; repository ESLint cannot parse this standalone `.mjs` because its project service excludes the file. Blocker: the four allowlisted Trails system packs are all public (`private: false`) and accessible to the restricted player, so this installation has no inaccessible allowlisted pack against which to prove the required unauthorized-pack failure without mutating package/world permission configuration beyond smoke-test scope. P7-T2 therefore remains unchecked/blocked rather than overstating acceptance. |
| 2026-09-26 | P7-T2 | complete | pack-permission unblock agent | `node scripts/trails-live-smoke.mjs check-pack-permissions`; `core.compendiumConfiguration` | Snapshotted the exact world pack configuration (`{}`), temporarily assigned `PLAYER: NONE` to the allowlisted Character Options pack, and connected a temporary role-1 bridge user. The catalog list reported `accessible: false`/`entryCount: null`; REST returned only generic `HANDLER_ERROR`; Streamable HTTP MCP returned an error result; assertions found no entry, catalog-id, UUID, document-id, or raw-snapshot fields. Restored the exact original setting and client bridge URL/key, removed the temporary user, stopped temporary processes, and relaunched/verified the original `mcp-test` dnd5e join page. No system manifest or package permission source changed. |
| 2026-09-26 | P7-T3 / completion audit | complete | final verification agent | `eslint.config.js`, `server/src/scripts/generate-docs.ts`, `scripts/trails-live-smoke.mjs`, full repository gate | Fixed standalone smoke-harness lint coverage and made docs generation emit repository-formatted OpenAPI; generate, manifest sync (3/3), typecheck, lint (0 errors; 7 existing warnings), format, tests (390/390), and build passed. Audited every required checkbox and live-smoke entry, optional activation/manifests/docs, and the 13-operation Trails surface; no document, Combat, chat, resource, catalog, or builder persistence endpoint is exposed. |
