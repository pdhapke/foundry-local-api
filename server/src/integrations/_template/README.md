# Integration template

Phase 36 extracted this directory's structure straight out of the dnd5e
integration (Phases 32-35) — `dnd5e` is still the best real-world reference
to read alongside this checklist. This directory is **never** imported by
`server/src/integrations/registry.ts` and **never** referenced by
`module.json`; it's scaffolding only, kept out of both so `_template` never
shows up as a real (even if inactive) integration. Copy it, then work through
the steps below in order.

## Checklist

1. Copy this whole directory to `server/src/integrations/<your-id>/` (e.g.
   `server/src/integrations/pf2e/`).

2. Create `shared/src/<your-id>.ts`: a `<YOUR_ID>_COMMANDS` const object
   (string command names) plus one input/result TypeScript interface pair per
   command. Model it exactly on `shared/src/dnd5e.ts` — including that
   file's precedent of defining its own one-field id input locally rather
   than cross-importing a shape from another domain file. Export everything
   from `shared/src/index.ts` too, the same way every other domain file is
   exported there (see the `dnd5e.js` lines).

3. In your copied `endpoints.ts`, delete the local placeholder
   `TEMPLATE_COMMANDS` object and its two placeholder interfaces, and import
   the real command map + types from `@foundry-local-api/shared` instead.
   Write one `EndpointDescriptor` per REST route + MCP tool your integration
   exposes. Reminders (see `server/src/integrations/types.ts`'s `Integration.id`
   doc comment and `dnd5e/endpoints.ts` for the pattern):
   - `path` must start with `/<your-id>` — the dynamic integration router
     (`server/src/integrations/router.ts`) mounts every active integration
     under `/api/integrations`, so the real path becomes
     `/api/integrations/<your-id>/...`.
   - MCP tool `name` should be prefixed `<your-id>_` (e.g. `dnd5e_get_config`).

4. In your copied `index.ts`, fill in the real `id`, `kind`
   (`"system"` for a game system like pf2e, `"module"` for a companion
   module), and `detect()` (for `kind: "module"`, check
   `activeModuleIds.includes("your-module-id")` instead of the system id).
   Point `endpoints` at your real descriptors from step 3.

5. Write `module/src/commands/<your-id>.ts`: one `registerCommand()` call per
   command, reading Foundry's *live* `game`/document objects. If you don't
   have a live instance of the target system/module to verify field paths
   against, follow `module/src/commands/dnd5e.ts`'s pattern:
   - defensive optional-chaining reads with sensible fallbacks (`?? 0`,
     `?? {}`, `[]`, etc.) instead of assuming a field exists;
   - a `callFirstAvailableMethod()`-style multi-candidate-name helper for any
     action whose exact method name you're not 100% sure of (dnd5e's own
     method names moved across its 2.x/3.x/4.x releases — the target
     system/module you're integrating may have the same problem);
   - a loud header-comment caveat flagging exactly what's unverified, same
     as `dnd5e.ts`'s header.

   Then add `import "./commands/<your-id>.js";` to `module/src/index.ts`'s
   existing flat import list.

6. Register it for real in `server/src/integrations/registry.ts`: import
   your integration object and add it to the `integrations` array.

7. Declare it in `module.json`: one entry in `relationships.recommends`
   (human/Foundry-facing) and one matching entry in
   `flags["foundry-local-api"].optionalIntegrations` (loader-facing — the
   actual source of truth `check-manifest-sync.ts` reads). If you're
   declaring it ahead of writing the code, set `"implemented": false` on the
   manifest entry (Phase 33's convention — lets the manifest entry land
   first without failing the sync check); flip it to `true` (or remove the
   key) once step 6's code is real. Run `npm run check-manifest-sync` to
   confirm the two sides agree.

8. Write `server/src/integrations/<your-id>/endpoints.test.ts` following
   `server/src/integrations/dnd5e/endpoints.test.ts`'s harness: mount your
   descriptors directly on a bare Express app with a fake `FoundryClient`,
   one happy-path test per route. Module-side command handlers generally
   aren't unit-tested in this codebase — they need a real or heavily-mocked
   `game` global, which has been judged out of scope every time it's come up
   (see Phase 31's and Phase 34's PLAN.md deviation-log entries) — so don't
   feel obligated to build that harness from scratch either, unless your
   integration's module-side logic has meaningfully pure, extractable pieces
   worth testing in isolation (see `dnd5e.ts`'s `callFirstAvailableMethod`/
   `toRollActionResult` for an example of what IS worth pulling out).

9. Regenerate docs: `npm run generate:docs --workspace=server`, then
   `npm run format` if the regenerated `docs/openapi.json` fails
   `npm run format:check` (a known pre-existing `JSON.stringify`-vs-Prettier
   formatting mismatch — see Phase 31's deviation log).

10. Run the full verification pass from the repo root:
    `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run check-manifest-sync`.

## Candidate future integrations

PLAN.md's own Phase 36 text names these as worth noting but not building
yet — each just needs a `detect()` and an endpoint set following this same
pattern:

- Other game systems (e.g. pf2e).
- Utility modules with a useful public API (`kind: "module"`, detected via
  `activeModuleIds` instead of the active system id).
