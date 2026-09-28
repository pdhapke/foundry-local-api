# Trails of Destiny system audit for foundry-local-api

Status: **COMPLETE — system audit only; no integration code implemented.**

## Identity and runtime boundary

- Foundry system id: `trails-of-destiny`; title: `Trails of Destiny`; package version: `0.1.0`; Foundry minimum/verified: `14.368` (`Data/Data/systems/trails-of-destiny/system.json`). Persisted rules version is `0.1` (`scripts/config.mjs`); the pure gameplay-result contract separately reports `GAMEPLAY_RULES_VERSION = "0.2"` (`scripts/gameplay.mjs`). Do not conflate these versions.
- Entrypoint: `scripts/trails.mjs`, loaded as an ES module. On `Hooks.once("init")` it sets `CONFIG.TRAILS = TRAILS`, then attaches the imported namespaces as `CONFIG.TRAILS.creation`, `.gameplay`, and `.builder`; it registers Actor/Item data models and sheets. `Hooks.once("ready")` only logs readiness. There is no `game.trails` API, socket API (`system.json` has `socket: false`), or custom public Hooks contract.
- Optional activation should use foundry-local-api's existing integration framework: add a `kind: "system"` integration whose `detect(activeSystemId)` is `activeSystemId === "trails-of-destiny"`. The authoritative framework is `server/src/integrations/{types.ts,manager.ts,registry.ts,router.ts,mcp-tools.ts}`. Inactive REST paths already receive `INTEGRATION_INACTIVE`; inactive MCP tools are omitted dynamically.
- Follow `server/src/integrations/_template/README.md` and the dnd5e precedent. Expected namespace: REST `/api/integrations/trails-of-destiny/...`; MCP prefix should be a legal, consistent normalized id such as `trails_` (the framework documentation assumes `${id}_`, so decide whether the integration id remains the exact system id and explicitly validate hyphenated MCP names, or introduce a separate tool prefix before implementation). Do not silently use an integration id that breaks detection/manifest synchronization.
- Module-side handlers may be registered unconditionally via a side-effect import in `module/src/index.ts`, as dnd5e is. They must not import Trails modules that require unavailable Foundry globals during non-Trails worlds. Prefer live `CONFIG.TRAILS` capability checks inside handlers. Pure system modules can be imported only where their import graph is proven browser/Foundry-safe.

## Document model

### Actors

`character` and `npc` both use `TrailsActorData` (`scripts/models/actor.mjs`; registered in `scripts/trails.mjs`). Persisted `system` data includes:

- `schemaVersion` (1), `rulesVersion` (`0.1`); `details` (`level`, concept/history/destiny and affinities, languages, biography, campaign notes).
- `creation`: contract/builder versions, generation and recorded-roll evidence, stable selection instance ids, issued selections, equipment check, orbment lines/placements/Tinker evidence, and lossless `sourceSnapshot`.
- Nine abilities `str sta agi spd sol emp mem rea rsl`, each `{value, bonus}`.
- Live resources `durability health vigor mana energy`, each persisting `value`; defenses `{guard, ward, armor}`, `actions`, `reputation`, currency `{mira,equipmentAllowance}`, and adjudication records.
- Prepared-only derived fields: ability `total`/`bonusDice`, resource `max`, movement `{combat,overland}`, and `carryingCapacity`. Return prepared values from live actor documents but never persist them as authoritative inputs. `prepareDerivedData()` is idempotent and leaves resource values untouched.

Primary/secondary token attributes are `resources.health` and `resources.vigor`; grid defaults are 5 ft (`system.json`). HTML-bearing Actor fields are `details.biography` and `details.campaignNotes`.

### Items

Types are `talent`, `connection`, `craft`, `equipment`, `quartz`, and `core` (`system.json`, `scripts/config.mjs`, `scripts/models/*.mjs`). Every type extends `TrailsItemData` with `schemaVersion`, `catalogId`, HTML `description`, structured source citation, rule `status` (`implemented|interpretation|reference|unresolved`), free-text `provenance`, portable `instanceId`, and structured `origin` fields (`scripts/models/item.mjs`, `scripts/contracts/{source,ownership}.mjs`). Foundry `_id`, reusable `catalogId`, and owned-copy `instanceId` are distinct identities.

- Talent: category, rank, skill-point cost, choice, recorded d6 rolls, active, purchase order.
- Connection: connection type/category/quality/rank/identity/active.
- Craft: entitlement/base/modifier ids and choice, school/affinity/rank/type, resource/cost/range/duration/form.
- Equipment: category/quality/quantity/price, equipped/attuned/hands/armor, acquisition and granting source.
- Quartz: element/rank/socket/equipped/arts/acquisition.
- Core: core type/element/rank/socket/equipped/arts/acquisition.

Four public Item compendia are declared: `trails-of-destiny.character-options`, `.social`, `.crafts-arts`, and `.equipment-orbment`. Runtime catalog helpers and exact pack ids live in `scripts/features/sheets/integration.mjs` (`CATALOG_PACKS`, `loadRuntimeCatalogContext`, `loadRuntimeCatalogs`). Catalog identity should be exposed by `catalogId`; callers must not treat a compendium UUID as portable identity.

## Useful domain APIs and recommended capabilities

The system deliberately separates immutable computation from Foundry persistence. `scripts/creation.mjs`, `scripts/gameplay.mjs`, and `scripts/builder.mjs` are public barrel modules and are mounted at `CONFIG.TRAILS.{creation,gameplay,builder}`.

Recommended first read-only slice:

1. `trails_get_config`: system/rules/gameplay versions, abilities, Item types, damage types, die ranks, and active capabilities from `CONFIG.TRAILS`. This lets clients avoid hardcoded enums.
2. `trails_get_actor_sheet`: structured identity, prepared abilities/resources/movement/capacity, defenses/actions/reputation/currency, schema/rules evidence, and explicit readiness findings. Use `Actor.toObject()`/prepared live fields defensively and enforce document visibility.
3. `trails_get_actor_inventory`: embedded Items with `_id`, `catalogId`, `instanceId`, origin/citation/status, plus type-specific fields. Do not collapse duplicate catalog ids.
4. `trails_get_catalogs` or pack-scoped catalog lookup: use `loadRuntimeCatalogContext()` and existing generic pack endpoints; avoid returning the lossless builder snapshot by default.
5. Preview-only computations: `creation.evaluateCreation`, `gameplay.resolveActionRoll`, `previewInitiative`, `previewThreatContest`, `previewPostMitigationDamage`, `buildRecoveryPlan`, timing/range reference helpers, and `experienceProgress`. Name tools/routes as previews and preserve their returned manual/reference boundaries.
6. Builder preview: `parseBuilderV1`, `validateBuilderV1`, `previewBuilderV1`, and `prepareFoundryImport`. Keep the 2 MB parser limit and return `issues` plus `unmapped`; an empty issue list does not authorize persistence or data loss (`docs/import-contract.md`).

Write capabilities should be later and narrower:

- Actor/item field edits can use Foundry document update APIs only after ownership/GM checks and schema-specific allowlists. Sheet helpers `characterEditPatch` and inventory/orbment patch builders are useful validators but are not purchase/gameplay authorization.
- Actor creation/import may wrap `prepareFoundryImport` then `createFoundryActor`, preserving `sourceSnapshot`, assigning unique `instanceId`s, and exposing all readiness issues. It is a material write and should not be bundled into the preview endpoint.
- Action rolls are pure random resolution: `resolveActionRoll` does not create chat or spend resources. A future “roll and post” endpoint must make that side effect explicit.
- Recovery/damage/resource/gameplay application must use `executeGameplayRequest` (`scripts/features/gameplay/transactions/request.mjs`) with a persisted idempotency journal, requester authorization, revision check, approved plan, atomic commit, and applied-result chat record. The included `GameplayRequestJournal` is process-local test/reference state and is not production authority.
- Builder create/reconcile writes should honor the parallel builder request/persistence contracts (`features/builder/{request,persistence,foundry-persistence}.mjs`), not directly apply generated patches.

## Tests and integration seams

- Trails tests use Node 20's built-in `node:test` plus `node:assert/strict`; `npm test` runs `node --test tests/*.test.mjs`. Pure rules tests inject deterministic dice. Model tests install a small Foundry-field shim from `test-support/foundry-fields.mjs` before dynamically importing data models. Migration support is similarly isolated in `test-support/migrations.mjs`.
- foundry-local-api uses TypeScript Node tests. Mirror `server/src/integrations/dnd5e/endpoints.test.ts`: mount descriptors on a bare Express router with a fake `FoundryClient`, and assert bridge command names/payloads/results. Framework activation/inactive behavior is already covered by integration manager/router/MCP tests; add a Trails registry/detection assertion and one descriptor test per route.
- Add shared command constants and DTO types in `shared/src/trails-of-destiny.ts` and export them from `shared/src/index.ts`; add module handlers in `module/src/commands/trails-of-destiny.ts`; add server descriptors under `server/src/integrations/trails-of-destiny/`; register both the module side-effect import and server registry entry.
- Declare the optional system in both `module.json` locations: `relationships.recommends` and `flags["foundry-local-api"].optionalIntegrations`; the latter must match code and `implemented` state. Run `npm run check-manifest-sync`, docs generation, typecheck, lint, format check, tests, and build per the template checklist.

## Risks and non-negotiable boundaries

- **Version churn:** package `0.1.0` and rules/gameplay contracts are pre-1.0. Return versions with results and consider `minVersion: "0.1.0"`; fail on absent capabilities rather than guessing field paths.
- **API exposure:** `CONFIG.TRAILS` is established during `init`; handlers execute later but must report a clear capability error if namespaces/functions are absent. The package documents barrels but not a stability/compatibility promise for third-party integrations.
- **Permissions and secrets:** generic collection access can bypass sheet UX assumptions. Enforce normal Foundry visibility/ownership and GM-only policies for mutations. Treat `creation.sourceSnapshot`, biography, campaign notes, adjudications, and builder evidence as sensitive; omit by default or gate explicitly.
- **Identity:** never deduplicate owned Items by `catalogId`; preserve distinct `instanceId`, source instance, grant, and slot keys. Never generate identities during data preparation.
- **Reference versus automation:** many status records and helpers are deliberately `reference`, `interpretation`, or `unresolved`. `MANUAL_BOUNDARY`, `INVENTORY_BOUNDARY`, timing/targeting boundaries, readiness findings, and unverified recovery claims must survive transport; do not present previews as applied outcomes.
- **Atomicity/idempotency:** do not expose raw “apply damage/recovery/import” shortcuts. The system requires revision checks, authorization, duplicate request protection, and atomic mutation plus result-card creation.
- **Randomness:** allow server/module-side secure/current RNG for actual rolls; deterministic dice injection is for tests/previews. Never accept caller-supplied “rolled” totals as trusted applied evidence without policy.
- **Docs/tool naming:** system id contains hyphens while current MCP convention/examples use underscore-safe ids. Resolve this explicitly and test tool registration/discovery before documenting the public names.

## Suggested delivery phases

1. Shared contracts, exact optional-manifest declaration, detection/registry wiring, and activation tests.
2. Read-only config, actor-sheet, inventory, and catalog endpoints/tools with permissions and redaction tests.
3. Pure preview endpoints for creation/readiness and gameplay; deterministic unit fixtures and boundary propagation.
4. Builder preview and import-plan endpoints; no writes.
5. Explicit actor import/create transaction with authorization, identities, diagnostics, and live-world smoke test.
6. Gameplay mutations only after a persisted journal and atomic Foundry adapter exist; live-world smoke test and rollback/idempotency tests.
7. Regenerate OpenAPI/MCP docs and run the full repository verification checklist.

**AUDIT_COMPLETE: trails-of-destiny optional REST/MCP integration surface and boundaries recorded.**
