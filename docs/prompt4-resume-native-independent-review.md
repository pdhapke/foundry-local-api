# Prompt4 fresh native read-only review — 2026-10-03

No implementation changes, runtime calls, fixtures, builds or inference. Reviewed latest AI docs/prompt4-final-acceptance.md and native audit/follow-up reports, then inspected current schema-discovery.ts and scene-render.test.ts.

Historical blockers already repaired: numeric object-backed NumberField choice keys were strings; flattened defaults manufactured a nullable null ActorDelta; native DocumentOwnershipField map keys were incorrectly unknown. All three narrow repairs remain in current source. Multiple-source activation also depends on native controlled-token selection; ownership alone does not activate every source. Current native tests isolate selected-token evidence, reject unattributable sources, and avoid turning clipped FOV into radial range.

Fresh independent command (local-api): node --import tsx --test module/src/commands/schema-discovery.test.ts module/src/commands/scene-render.test.ts
Result: exit 0; 46 tests passed; 2 suites; 0 failed/skipped/cancelled; duration 555.6287ms. Includes numeric Wall choices, null ActorDelta, native ownership rejection, hidden identifiers, selected-source isolation, secret/lighting/range uniformly unknown, consent recheck, query elevation, readiness refusal and clipped FOV uncertainty.

Latest saved final acceptance reports repaired secret/source live outcomes and manually accepted deterministic public terrain sentence. This review does not independently assert current browser/server readiness. Parent reports only GM connected and player enrollment expired. Automatic renewal remains explicitly deferred; no fresh player request is authorized by historic identity alone. Other vision modes, actual elevation movement, complex path/trap combinations, strict natural model narration remain outside bounded acceptance. No native implementation gap found requiring edits for this resumed first effort.
