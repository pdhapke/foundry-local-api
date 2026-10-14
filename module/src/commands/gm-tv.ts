import {
  GM_TV_COMMANDS,
  TV_CONTROL_VERSION,
  ProtocolError,
  assertIdempotencyKey,
  type TvCameraState,
  type TvControlCommandInput,
  type TvControlResult,
} from "@foundry-local-api/shared";
import {
  getClientId,
  getClientLane,
  MODULE_ID,
  ALLOW_REMOTE_CONTROL_SETTING,
} from "../bridge-client.js";
import { registerCommand } from "../command-registry.js";

interface TvActor {
  id: string;
  type?: string;
  testUserPermission(user: FoundryUser, permission: "OBSERVER" | "OWNER"): boolean;
}
interface TvToken {
  actor?: TvActor;
  hasSight: boolean;
  controlled: boolean;
  document: { id: string; hidden: boolean; level: string; sight: { enabled: boolean } };
}
type TvTokenDocument = TvToken["document"] & {
  actor?: TvActor;
};
interface TvSource {
  active: boolean;
  object?: TvToken;
  isPreview?: boolean;
  data?: { vision?: boolean };
}
interface TvCanvas {
  ready: boolean;
  scene: {
    id: string;
    tokenVision: boolean;
    grid: { size: number; type: number };
    tokens: { values(): IterableIterator<TvTokenDocument> };
  };
  level: { id: string };
  tokens: { placeables: TvToken[]; controlled: TvToken[]; releaseAll(): void };
  effects: {
    visionSources: { values(): IterableIterator<TvSource> };
    lightSources: { values(): IterableIterator<TvSource> };
  };
  stage: { pivot: { x: number; y: number }; scale: { x: number } };
  animatePan(view: { x: number; y: number; scale: number }): Promise<unknown>;
}
const receipts = new Map<
  string,
  {
    fingerprint: string;
    result?: TvControlResult;
    pending?: Promise<TvControlResult>;
    uncertain?: boolean;
  }
>();
let applying = false;
function fail(
  code:
    | "INVALID_PAYLOAD"
    | "PERMISSION_DENIED"
    | "NOT_FOUND"
    | "UNSUPPORTED_TYPE"
    | "UNSUPPORTED_VERSION"
    | "STALE_REVISION"
    | "IDEMPOTENCY_CONFLICT"
    | "INCOMPLETE_RESULT",
  message: string,
): never {
  throw new ProtocolError({ code, message, retryable: false });
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
function finite(value: unknown, min = -1e7, max = 1e7): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function exactKeys(value: unknown, keys: string[]): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((k) => keys.includes(k))
  );
}
function validate(input: TvControlCommandInput): void {
  if (
    !exactKeys(input, [
      "version",
      "worldId",
      "sceneId",
      "tvUserId",
      "tvClientId",
      "action",
      "camera",
      "calibration",
      "perspective",
      "expectedState",
      "idempotencyKey",
      "requestingUserId",
    ])
  )
    fail("INVALID_PAYLOAD", "Unexpected TV control field.");
  if (input.version !== TV_CONTROL_VERSION)
    fail("UNSUPPORTED_VERSION", "Unsupported TV control version.");
  if (
    ![input.worldId, input.sceneId, input.tvUserId, input.tvClientId, input.requestingUserId].every(
      id,
    )
  )
    fail("INVALID_PAYLOAD", "TV scope identifiers are required.");
  if (!["inspect", "unionVision", "camera", "calibrate", "perspective"].includes(input.action))
    fail("INVALID_PAYLOAD", "Unknown TV action.");
  if (input.action === "camera") {
    if (
      !exactKeys(input.camera, ["x", "y", "scale"]) ||
      !finite(input.camera?.x) ||
      !finite(input.camera?.y) ||
      !finite(input.camera?.scale, 0.1, 3)
    )
      fail("INVALID_PAYLOAD", "A bounded absolute camera is required.");
  } else if (input.camera !== undefined)
    fail("INVALID_PAYLOAD", "camera belongs only to the camera action.");
  if (input.action === "calibrate") {
    const c = input.calibration;
    if (
      !exactKeys(c, ["measuredPixels", "measuredInches", "gridInches", "rulerConfirmed"]) ||
      !finite(c?.measuredPixels, 1, 10000) ||
      !finite(c?.measuredInches, 0.01, 200) ||
      !finite(c?.gridInches, 0.1, 10) ||
      c?.rulerConfirmed !== true
    )
      fail(
        "INVALID_PAYLOAD",
        "Calibration requires a confirmed physical ruler sample from this TV.",
      );
  } else if (input.calibration !== undefined)
    fail("INVALID_PAYLOAD", "calibration belongs only to the calibrate action.");
  if (input.action === "perspective") {
    if (input.perspective !== "native-top-down")
      fail("UNSUPPORTED_TYPE", "Core Foundry supports only its native top-down perspective here.");
  } else if (input.perspective !== undefined)
    fail("INVALID_PAYLOAD", "perspective belongs only to the perspective action.");
  if (input.action !== "inspect") {
    if (typeof input.idempotencyKey !== "string")
      fail("INVALID_PAYLOAD", "TV apply requires an idempotency key.");
    assertIdempotencyKey(input.idempotencyKey);
    const e = input.expectedState;
    if (
      !exactKeys(e, ["sceneId", "x", "y", "scale"]) ||
      e?.sceneId !== input.sceneId ||
      !finite(e.x) ||
      !finite(e.y) ||
      !finite(e.scale, 0.1, 3)
    )
      fail("INVALID_PAYLOAD", "TV apply requires the inspected camera state.");
  } else if (input.expectedState !== undefined || input.idempotencyKey !== undefined)
    fail("INVALID_PAYLOAD", "inspect does not accept apply state.");
}
function context(input: TvControlCommandInput): TvCanvas {
  const requester = game.users.get(input.requestingUserId);
  if (
    game.world.id !== input.worldId ||
    game.user.id !== input.tvUserId ||
    getClientId() !== input.tvClientId ||
    getClientLane() !== "tv" ||
    game.user.isGM ||
    !requester?.isGM ||
    !requester.active ||
    requester.name.toLowerCase() === "tv" ||
    !game.settings.get<boolean>(MODULE_ID, ALLOW_REMOTE_CONTROL_SETTING)
  )
    fail(
      "PERMISSION_DENIED",
      "TV control requires the exact consenting non-GM TV client and an active native GM requester.",
    );
  if (!game.release.version.startsWith("14."))
    fail("UNSUPPORTED_VERSION", "Native TV union is audited for Foundry 14 only.");
  const c = canvas as unknown as TvCanvas | undefined;
  if (!c?.ready || c.scene?.id !== input.sceneId)
    fail("NOT_FOUND", "The requested scene is not viewed on this TV client.");
  if (
    !c.scene.tokenVision ||
    !c.scene.tokens?.values ||
    !c.level?.id ||
    !c.tokens?.releaseAll ||
    !c.effects?.visionSources?.values ||
    !c.effects?.lightSources?.values ||
    !c.animatePan
  )
    fail(
      "UNSUPPORTED_TYPE",
      "Native token vision and source inspection are required; full-map fallback is prohibited.",
    );
  return c;
}
function cameraState(c: TvCanvas): TvCameraState {
  const state = {
    sceneId: c.scene.id,
    x: c.stage.pivot.x,
    y: c.stage.pivot.y,
    scale: c.stage.scale.x,
  };
  if (!finite(state.x) || !finite(state.y) || !finite(state.scale, 0.1, 3))
    fail("INCOMPLETE_RESULT", "TV canvas returned an invalid camera state.");
  return state;
}
function sameCamera(a: TvCameraState, b: TvCameraState): boolean {
  return (
    a.sceneId === b.sceneId &&
    Math.abs(a.x - b.x) < 0.001 &&
    Math.abs(a.y - b.y) < 0.001 &&
    Math.abs(a.scale - b.scale) < 0.000001
  );
}
function canObserve(
  actor: TvActor | undefined,
  user: FoundryUser,
  permission: "OBSERVER" | "OWNER",
): boolean {
  try {
    return actor?.testUserPermission(user, permission) === true;
  } catch {
    return false;
  }
}
/** Include every native Character with a non-GM player OWNER, assigned or unassigned. */
function partyActors(): Set<string> {
  const ids = new Set<string>();
  const owners = [...game.users.values()].filter((user) => !user.isGM && user.id !== game.user.id);
  for (const document of game.collections.get("Actor")?.values() ?? []) {
    const actor = document as unknown as TvActor;
    if (actor.type === "character" && owners.some((user) => canObserve(actor, user, "OWNER")))
      ids.add(actor.id);
  }
  return ids;
}
function unionCandidates(c: TvCanvas): TvToken[] {
  const party = partyActors();
  // Native hasSight depends on the viewed level. Inspect configured sight on
  // every placed party document before filtering the current canvas sources.
  const required = [...c.scene.tokens.values()].filter(
    (t) => !t.hidden && t.sight?.enabled === true && !!t.actor && party.has(t.actor.id),
  );
  for (const t of required) {
    if (t.level !== c.level.id)
      fail(
        "UNSUPPORTED_TYPE",
        "Party sight spans scene levels; the complete native PC union is unavailable on this viewed level.",
      );
    if (!canObserve(t.actor, game.user, "OBSERVER"))
      fail(
        "PERMISSION_DENIED",
        "Native union is blocked: at least one party vision source lacks existing TV OBSERVER permission. Permission changes require separate user approval.",
      );
  }
  const candidates: TvToken[] = [];
  for (const t of c.tokens.placeables) {
    if (t.document.hidden || !t.hasSight || t.document.level !== c.level.id) continue;
    const pc = !!t.actor && party.has(t.actor.id);
    const observe = canObserve(t.actor, game.user, "OBSERVER");
    if (pc && !observe)
      fail(
        "PERMISSION_DENIED",
        "Native union is blocked: at least one party vision source lacks existing TV OBSERVER permission. Permission changes require separate user approval.",
      );
    if (!pc && observe)
      fail("PERMISSION_DENIED", "Native union is blocked by an observable non-party sight source.");
    if (pc) candidates.push(t);
  }
  if (required.some((doc) => !candidates.some((t) => t.document.id === doc.id)))
    fail(
      "UNSUPPORTED_TYPE",
      "A placed party sight source is unavailable on this TV canvas; the complete native PC union cannot be verified.",
    );
  if (!candidates.length)
    fail(
      "UNSUPPORTED_TYPE",
      "Native union requires party sight sources in the current viewed level.",
    );
  if ([...c.effects.lightSources.values()].some((s) => s.active && s.data?.vision))
    fail(
      "PERMISSION_DENIED",
      "Native union is blocked by a light source which independently grants vision.",
    );
  return candidates;
}
function verifyUnion(c: TvCanvas, candidates: TvToken[]): void {
  if (c.tokens.controlled.length !== 0)
    fail(
      "PERMISSION_DENIED",
      "Release TV token selection with unionVision before moving the camera.",
    );
  const active = [...c.effects.visionSources.values()].filter((s) => s.active);
  if (
    active.length !== candidates.length ||
    active.some((s) => s.isPreview || !s.object || !candidates.includes(s.object)) ||
    candidates.some((t) => !active.some((s) => s.object === t))
  )
    fail(
      "PERMISSION_DENIED",
      "The TV's exact native party union cannot be verified. No visibility override will be applied.",
    );
}
/** Await native perception rendering; never initialize foreign sources or override visibility. */
async function releaseSelection(c: TvCanvas): Promise<void> {
  if (c.tokens.controlled.length === 0) return;
  const hooks = Hooks as unknown as {
    on(name: string, callback: () => void): number;
    off(name: string, id: number): void;
  };
  if (!hooks?.on || !hooks.off)
    fail("UNSUPPORTED_TYPE", "Native perception completion hooks are unavailable.");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      hooks.off("sightRefresh", hookId);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new ProtocolError({
          code: "INCOMPLETE_RESULT",
          message:
            "TV selection release did not receive native perception completion. Inspect before retrying.",
          retryable: false,
        }),
      );
    }, 2000);
    const hookId = hooks.on("sightRefresh", () => {
      cleanup();
      resolve();
    });
    try {
      c.tokens.releaseAll();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
function result(
  input: TvControlCommandInput,
  c: TvCanvas,
  count: number,
  blockedReason: string | null = null,
): TvControlResult {
  return {
    version: TV_CONTROL_VERSION,
    worldId: input.worldId,
    tvUserId: input.tvUserId,
    tvClientId: input.tvClientId,
    action: input.action,
    camera: cameraState(c),
    vision: {
      mode: "native-pc-union",
      status: blockedReason ? "blocked" : "verified",
      blockedReason,
      sourceCount: count,
      nativeWallsFogDetection: true,
      permissionsChanged: false,
    },
    perspective: "native-top-down",
    calibration: { physicalVerified: false, rulerAcceptanceRequired: true },
    replayed: false,
  };
}
export async function executeTvControl(input: TvControlCommandInput): Promise<TvControlResult> {
  validate(input);
  const c = context(input);
  if (input.action === "inspect") {
    try {
      const candidates = unionCandidates(c);
      verifyUnion(c, candidates);
      return result(input, c, candidates.length);
    } catch (error) {
      if (
        error instanceof ProtocolError &&
        ["PERMISSION_DENIED", "UNSUPPORTED_TYPE"].includes(error.code)
      )
        return result(input, c, 0, error.message);
      throw error;
    }
  }
  const candidates = unionCandidates(c);
  const key = `${input.worldId}:${input.tvClientId}:${input.idempotencyKey}`;
  const fingerprint = JSON.stringify(input);
  const prior = receipts.get(key);
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      fail("IDEMPOTENCY_CONFLICT", "TV idempotency key was used for different parameters.");
    if (prior.uncertain)
      fail(
        "INCOMPLETE_RESULT",
        "Prior TV apply is uncertain. Inspect the TV before issuing a new key.",
      );
    const replay = prior.result ?? (await prior.pending);
    if (!replay) fail("INCOMPLETE_RESULT", "TV receipt is incomplete.");
    if (context(input) !== c)
      fail("INCOMPLETE_RESULT", "TV canvas instance changed during receipt replay.");
    verifyUnion(c, unionCandidates(c));
    if (!sameCamera(cameraState(c), replay.camera))
      fail(
        "STALE_REVISION",
        "TV camera changed since this receipt; inspect before applying a new key.",
      );
    return { ...replay, replayed: true };
  }
  if (applying)
    fail("STALE_REVISION", "Another TV apply is in progress; inspect after it settles.");
  if (receipts.size >= 256)
    fail(
      "INCOMPLETE_RESULT",
      "TV receipt capacity reached. Reload and inspect before continuing; no receipt is silently evicted.",
    );
  if (!sameCamera(cameraState(c), input.expectedState!))
    fail("STALE_REVISION", "TV camera changed after inspection.");
  if (input.action === "calibrate" && c.scene.grid.type !== 1)
    fail("UNSUPPORTED_TYPE", "Physical calibration requires a native square scene grid.");
  if (input.action !== "unionVision") verifyUnion(c, candidates);
  applying = true;
  const receipt: {
    fingerprint: string;
    result?: TvControlResult;
    pending?: Promise<TvControlResult>;
    uncertain?: boolean;
  } = { fingerprint };
  receipts.set(key, receipt);
  const pending = (async () => {
    try {
      if (input.action === "unionVision") await releaseSelection(c);
      if (input.action === "camera" || input.action === "calibrate") {
        let target = input.camera;
        if (input.action === "calibrate") {
          const sample = input.calibration!;
          const scale =
            ((sample.measuredPixels / sample.measuredInches) * sample.gridInches) /
            c.scene.grid.size;
          if (!finite(c.scene.grid.size, 1, 10000) || !finite(scale, 0.1, 3))
            fail(
              "INVALID_PAYLOAD",
              "Ruler calibration yields a zoom outside the supported native range.",
            );
          target = { x: input.expectedState!.x, y: input.expectedState!.y, scale };
        }
        await c.animatePan(target!);
        context(input);
        if (!sameCamera(cameraState(c), { sceneId: input.sceneId, ...target! }))
          fail(
            "INCOMPLETE_RESULT",
            "Native camera readback differs from the requested view; inspect before retrying.",
          );
      }
      const fresh = context(input);
      if (fresh !== c)
        fail(
          "INCOMPLETE_RESULT",
          "TV canvas instance changed during apply. Inspect the current TV before retrying.",
        );
      verifyUnion(c, unionCandidates(c));
      receipt.result = result(input, c, candidates.length);
      return receipt.result;
    } catch (error) {
      receipt.uncertain = true;
      throw error;
    } finally {
      applying = false;
    }
  })();
  receipt.pending = pending;
  return pending;
}
registerCommand(GM_TV_COMMANDS.EXECUTE, executeTvControl);
