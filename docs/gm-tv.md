# Authenticated TV controls

`foundry_tv_control` (`POST /tv/control`, bridge command `gmTvControl`) operates only on the exact enrolled, opted-in `tvUserId` + `tvClientId`. The required `requestingUserId` selects an existing authenticated GM lane; it never grants authority. This preserves the exact DM principal when multiple GMs are connected. The TV runtime independently rejects GM roles, other users/clients/worlds/scenes, revoked consent, inactive or non-GM requesters, and unsupported Foundry versions. No broadcast socket message or alternate-client fallback is used. Add this command to the TV enrollment allowlist only.

Contract version: `tv-controls-v1`. Required scope: `worldId`, `sceneId`, `tvUserId`, `tvClientId`, `requestingUserId`. `inspect` returns current `{sceneId,x,y,scale}`, bounded union status (`verified` or `blocked`) and a reason. Every apply requires the exact inspected `expectedState` and an 8-128 character `idempotencyKey`.

| Action | Extra parameters | Native effect |
| --- | --- | --- |
| `inspect` | None | Read current local camera and verify native party source set |
| `unionVision` | None | Release local TV selection, await native `sightRefresh`, verify the exact native party source set |
| `camera` | `camera:{x,y,scale}` | Absolute local `canvas.animatePan`, independently read back pivot/zoom |
| `perspective` | `perspective:"native-top-down"` | Verify existing native top-down perspective and union; other perspective/rotation/3D is unsupported |
| `calibrate` | `calibration:{measuredPixels,measuredInches,gridInches,rulerConfirmed:true}` | Local zoom = measured CSS pixels per physical inch multiplied by requested grid inches, divided by scene grid pixels |

## Visibility boundary and supported native fallback

Foundry 14.368 `App/client/canvas/placeables/token.mjs` `_isVisionSource` allows existing Actor **OBSERVER** vision for a non-GM user when no sight token is controlled, excludes hidden tokens, and limits sources to the viewed scene level. Its `isVisible` and `App/client/canvas/groups/visibility.mjs` `testVisibility` continue to enforce hidden tokens, wall-derived sight polygons and native detection modes. The implementation uses those already-authorized native sources; it never replaces visibility tests, creates foreign vision sources, controls party tokens, copies GM vision, grants Actor ownership, changes role/security, disables token vision or resets fog.

The native party includes every Character Actor with at least one existing non-GM player OWNER, excluding the executing TV as a membership-defining owner. This includes assigned, unassigned, multiple and offline-owned PCs; `User.character` is not a completeness filter. Every non-hidden sight-enabled party token in the **current viewed level** must already grant the TV OBSERVER permission. Any observable non-party sight token, foreign/preview/duplicate native source, independently vision-granting light source, absent party source or unsupported canvas API blocks apply. `inspect` can return a blocked status and camera without mutating anything. `unionVision` is the sole operation allowed to release local TV selection, after preflight. Selection release awaits native perception completion and cleans its hook/timer; timeout reports an incomplete result and requires inspection.

The complete across-level union and arbitrary third-party vision/perspective engines are not supported. If non-hidden sight-enabled PCs span levels in this scene, apply explicitly blocks instead of claiming a partial party union. If existing permissions cannot provide the union, stop at the blocked result and request the user's separately scoped security decision; **no permission change is made by this tool**. Existing fog is preserved, including previously explored native fog. A live TV may already have broader permissions or third-party vision behavior; inspect/fail-closed checks do not constitute a security migration for that client.

### Exact permission prerequisites and operation sequence

1. Reuse the existing native Foundry users and Character Actors. Any Character with a non-GM player OWNER is a PC for this mechanism, whether assigned through `User.character` or not. This defines membership; the TV never receives OWNER permission from this operation.
2. The exact TV account must already be non-GM, signed in as the established native `TV` user, locally consent to bounded remote control, and have a current enrollment for the exact TV client. The requested GM must have one exact authenticated, active GM connection in the same world. The operation reads these facts; it never changes them.
3. Every non-hidden, sight-enabled party token must be in the viewed scene level, and the TV must already have native Actor OBSERVER permission or greater on its Actor. Missing permissions block the operation. A separately approved permission change, if needed, is a security decision rather than a calibration or camera step.
4. Call `inspect`. If its only blocking cause is local TV selection, call `unionVision` with the returned camera as `expectedState`. Native `releaseAll` releases this client's selected tokens; native `_onRelease` rebuilds its ordinary authorized sources. The tool waits for `sightRefresh`, then checks source identity and completeness. A permission, level, non-party-source or vision-light blocker cannot be repaired by releasing selection.
5. Apply an absolute `camera` or ruler-based `calibrate` using fresh inspected state. `camera` sets local x/y/zoom only. The camera animation is followed by native readback, exact source verification and renewed identity/consent checks. A native clamp or changed view returns uncertainty rather than false success.

Native perception continues updating these sources when tokens, walls, lighting or statuses change. The tool does not install continuous selection enforcement: a human selecting a TV token can narrow native vision, and subsequent TV controls fail until an explicit `unionVision` restores the observer source set. It does not silently activate historical or capture-dependent automation.

### Native source evidence

Evidence below was read from physical files in the installed **Foundry 14.368** application under `C:/dev/FoundryVtt/App`; these are source inspections, not live runtime acceptance or virtual sourcemap locations. For example, `C:/dev/FoundryVtt/App/client/canvas/placeables/token.mjs` and `C:/dev/FoundryVtt/App/client/canvas/groups/visibility.mjs` both exist on disk. The same `_isVisionSource` predicate is also present in the executable aggregate `C:/dev/FoundryVtt/App/public/scripts/foundry.mjs:162833` through line 162852. Line references below are to that installed version.

| Source and line | Native fact used by the mechanism |
| --- | --- |
| `client/canvas/placeables/token.mjs:983` | `_isVisionSource` requires native token vision and sight, rejects tokens outside the viewed level and hidden tokens for non-GMs, and does not use the GM observer path. |
| `client/canvas/placeables/token.mjs:1000` | Native Actor OBSERVER permission enables an unselected non-GM source. |
| `client/canvas/placeables/token.mjs:1002` | A selected, non-hidden sight token suppresses the fallback observer source set. This is why selection release is required for the native union. |
| `client/canvas/layers/base/placeables-layer.mjs:481` | `releaseAll` releases only the currently controlled placeables on that client. |
| `client/canvas/placeables/token.mjs:4637` | `_onRelease` calls native vision-source initialization for tokens and schedules native perception refresh. |
| `client/canvas/groups/visibility.mjs:601` | Native rendering iterates the active vision sources and draws their existing sight shapes at line 607; this produces the union rather than a replacement rectangle/full map. |
| `client/canvas/groups/visibility.mjs:828` | Native `sightRefresh` is emitted after the visibility refresh. |
| `client/canvas/placeables/token.mjs:605` | Native token visibility rejects hidden non-GM tokens and delegates remaining detection to the native visibility test. |
| `client/canvas/groups/visibility.mjs:843` | Native visibility testing handles the current source set; basic sight at line 875 and special detection at line 894 remain authoritative. At line 846 an absent source set yields visibility only for GMs; the TV tool never uses a GM context. |
| `client/canvas/sources/point-effect-source.mjs:129` | Native sight polygons use the configured source polygon backend; wall constraints are configured at line 144 and the polygon is created at line 162. The default source is wall-constrained at line 39. |
| `client/_types.mjs:340` | Core `CanvasViewPosition` consists of x/y/scale and scene level, with no perspective/3D/rotation field. |
| `client/canvas/board.mjs:1802` | Native `animatePan` animates x/y/scale through `pan`; `_constrainView` at line 1902 applies native bounds. |

### Implementation evidence and camera boundary

Paths below are relative to the staged `foundry-local-api` root. The native check never fabricates a source or copies a GM polygon.

| Implementation and line | Enforcement |
| --- | --- |
| `module/src/commands/gm-tv.ts:159` | Exact TV user/client/world/scene, native non-GM role, local consent and active native GM requester. |
| `module/src/commands/gm-tv.ts:226` | Existing Character Actors with a native non-GM player OWNER define party membership, including unassigned and multiple PCs. |
| `module/src/commands/gm-tv.ts:236` | Preflight native observer eligibility; cross-level PCs, missing permission, extra observable non-party sight and independent vision lights block. |
| `module/src/commands/gm-tv.ts:275` | Exact active native source set must equal eligible party tokens, without selected, preview, duplicate or foreign sources. |
| `module/src/commands/gm-tv.ts:293` | Local selection release awaits a bounded native perception completion and cleans up the hook/timer. |
| `module/src/commands/gm-tv.ts:355` | State-guarded and idempotent inspection/apply with uncertainty and final authority/source checks. |
| `server/src/endpoints/gm-tv.ts:131` | Real generic REST/MCP tool descriptor; no private DM or browser-only interaction. |
| `server/src/endpoints/gm-tv.ts:158` | Exact negotiated TV and GM connections are checked again after execution and auditing. |
| `server/src/endpoints/gm-tv.ts:186` | Current native GM user/world/active status are probed before and after TV dispatch on the exact requester lane. |

Pan, recenter and zoom are already expressible through bounded absolute `camera:{x,y,scale}`. The `perspective` action verifies the current native top-down presentation; it does **not** claim to rotate the canvas, provide 3D, or select an alternative scene/level. Those are unsupported by this safe control surface. Do not mutate PIXI transforms or broadcast a GM view to manufacture them. Other scene preparation, placement and token movement use the existing generic native scene/document tools and their explicit decision/permission boundaries. The TV must already be viewing the scoped scene before these controls apply.

### Executable recipe lookup

The `tv-camera-vision` recipe is marked for lookup and executable through the actual generic MCP `foundry_gm_recipe_invoke`. Discover it through `foundry_gm_recipe_list` or `foundry_gm_recipe_search`, then read its complete current parameter, precondition, verification and recovery contract using `foundry_gm_recipe_read` before invocation. The recipe accepts bounded `inspect`, `unionVision`, `camera`, `calibrate` and `perspective` actions. It preserves one exact `tvUserId` and `tvClientId` across its steps, binds `requestingUserId` to the authenticated recipe GM scope, and invokes the same exposed `foundry_tv_control` descriptor. Each apply uses current expected camera state and independently checks exact TV readback and native union. No alternate DM behavior, permission mutation or physical acceptance is introduced by recipe invocation.

Codex DM's `mcp_tv_read` and `mcp_tv_apply` wrappers also call this same actual generic tool with the authenticated principal and exact TV scope. Calibration continues reporting `physicalVerified:false`; the arithmetic/transport receipt never substitutes for later human ruler acceptance.

## Reliability and physical acceptance

Receipts are bounded to 256 per TV runtime; no receipt is silently evicted. Reusing a key with different inputs fails. In-flight identical requests share one execution; completed identical requests only replay if native union and camera still match. An uncertain native apply is not reissued for the same key. Inspect the same TV, reconcile state, and use a new key after the operator's decision. These are absolute local canvas changes and never spend resources or roll dice. Receipts do not survive browser reload, so reconnect/restart requires fresh inspection and expected state; enrollment itself remains fail-closed on expiry/restart. No capture-dependent automation is enabled.

Calibration is only for this TV client and never changes the Scene grid or another browser's view. The caller must supply an actual ruler sample measured on this TV in CSS pixels and physical inches. The result always says `physicalVerified:false` and `rulerAcceptanceRequired:true`: arithmetic and fake-provider tests cannot prove physical inches. Browser zoom, display replacement or DPR changes require a new ruler sample. Test hardware and inches only after live acceptance is authorized.

## Staged acceptance

Source/native-shaped tests cover exact multi-client selection, no GM/player fallback, permissions, hidden and foreign sources, delayed native perception, stale state, idempotency, uncertainty and calibration. Live Foundry, LAN, browser reconnect and physical ruler acceptance remain staged. After authorized deployment, verify two authenticated TVs plus a GM/player, disjoint PC vision separated by walls, hidden/invisible NPCs, fog and detection, local camera scope, revoked/expired enrollment, selection changes, multi-level fallback and a ruler at several grid locations. No runtime or installed assets are modified by this source stage.
