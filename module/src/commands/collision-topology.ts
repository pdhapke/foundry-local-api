import {
  COLLISION_COMMANDS,
  ProtocolError,
  inspectWallTopology,
  validatePathGeometry,
  type CollisionWall,
  type CollisionDoorState,
  type ValidateTokenPathInput,
  type ValidateTokenPathResult,
  type ValidateWallTopologyInput,
  type WallTopologyResult,
} from "@foundry-local-api/shared";
import { registerCommand } from "../command-registry.js";
type SceneLike = FoundryScene & { walls?: Map<string, FoundryDocument> };
function scene(id: string): SceneLike {
  const value = (game.collections.get("Scene") as Map<string, SceneLike> | undefined)?.get(id);
  if (!value)
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: `Scene "${id}" not found.`,
      retryable: false,
      fieldPath: "sceneId",
    });
  return value;
}
function data(doc: FoundryDocument): Record<string, unknown> {
  return doc.toObject();
}
function genuineRevision(value: Record<string, unknown>, fieldPath: string): string {
  const stats = value["_stats"] as Record<string, unknown> | undefined;
  const modifiedTime = stats?.["modifiedTime"];
  if (
    (typeof modifiedTime !== "number" && typeof modifiedTime !== "string") ||
    String(modifiedTime).length === 0
  )
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: `A genuine document revision is unavailable for ${fieldPath}; collision evidence cannot use an ID fallback.`,
      retryable: false,
      fieldPath,
    });
  return String(modifiedTime);
}
function walls(s: SceneLike, includeHidden: boolean): CollisionWall[] {
  const collection = s.getEmbeddedCollection("Wall");
  return [...collection.values()].flatMap((doc): CollisionWall[] => {
    const d = data(doc);
    const hidden = Boolean(d["hidden"]);
    if (hidden && !includeHidden) return [];
    const rawCoordinates = d["c"];
    return [
      {
        id: doc.id,
        c: (Array.isArray(rawCoordinates) ? rawCoordinates : []) as [
          number,
          number,
          number,
          number,
        ],
        door: Number(d["door"] ?? 0),
        ds: (typeof d["ds"] === "string" ? d["ds"] : Number(d["ds"] ?? 0)) as
          number | CollisionDoorState,
        ...(d["bottom"] === undefined ? {} : { bottom: Number(d["bottom"]) }),
        ...(d["top"] === undefined ? {} : { top: Number(d["top"]) }),
        move: Number(d["move"] ?? 1),
        dir: Number(d["dir"] ?? 0),
        hidden,
        revision: genuineRevision(d, `walls.${doc.id}`),
      },
    ];
  });
}
function hasRestrictedWallTopology(s: SceneLike): boolean {
  return [...s.getEmbeddedCollection("Wall").values()].some((document) => {
    const source = data(document);
    return source["hidden"] === true || Number(source["door"] ?? 0) === 2;
  });
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function signature(value: unknown): string {
  const text = stable(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function fogEvidence(
  sceneId: string,
): NonNullable<ValidateTokenPathResult["evidence"]["before"]["fog"]> {
  const userId = game.user.id;
  let fog: FoundryDocument | undefined;
  let source: Record<string, unknown> | undefined;
  for (const candidate of game.collections.get("FogExploration")?.values() ?? []) {
    const candidateSource = data(candidate);
    if (candidateSource["scene"] === sceneId && candidateSource["user"] === userId) {
      fog = candidate;
      source = candidateSource;
      break;
    }
  }
  if (!fog || !source)
    return {
      userId,
      exists: false,
      documentId: null,
      revision: null,
      stateSignature: signature(null),
    };
  return {
    userId,
    exists: true,
    documentId: fog.id,
    revision: genuineRevision(source, "fog"),
    stateSignature: signature({
      explored: source["explored"] ?? null,
      positions: source["positions"] ?? {},
    }),
  };
}
function assertScenePermission(s: SceneLike): void {
  const permission = (
    s as SceneLike & {
      testUserPermission?: (user: FoundryUser, level: string) => boolean;
    }
  ).testUserPermission;
  if (permission && !permission.call(s, game.user, "OBSERVER"))
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "The executing user cannot inspect this Scene.",
      retryable: false,
      fieldPath: "sceneId",
    });
}
function diagonalRule(s: SceneLike): "euclidean" | "manhattan" | "5105" {
  const configured = (s.grid as typeof s.grid & { diagonalRule?: unknown }).diagonalRule;
  if (configured === "euclidean" || configured === "manhattan" || configured === "5105")
    return configured;
  try {
    const system = game.settings.get<unknown>("dnd5e", "diagonalMovement");
    if (system === "EUCL" || system === "euclidean") return "euclidean";
    if (system === "MANH" || system === "manhattan") return "manhattan";
  } catch {
    // The setting is optional for non-dnd5e systems and older compatible worlds.
  }
  return s.grid.type === 0 ? "euclidean" : "5105";
}
interface LiveCollisionRead {
  token: {
    x: number;
    y: number;
    elevation: number;
    revision: string;
    sceneRevision: string;
    width: number;
    height: number;
  };
  walls: CollisionWall[];
  grid: { type: number; size: number; diagonalRule: "euclidean" | "manhattan" | "5105" };
  fog: NonNullable<ValidateTokenPathResult["evidence"]["before"]["fog"]>;
}
function liveRead(input: ValidateTokenPathInput): LiveCollisionRead {
  const s = scene(input.sceneId);
  assertScenePermission(s);
  if (!game.user.isGM) {
    if (Object.keys(input.simulatedDoors ?? {}).length > 0)
      throw new ProtocolError({
        code: "PERMISSION_DENIED",
        message: "Simulated door states require a GM execution lane.",
        retryable: false,
        fieldPath: "simulatedDoors",
      });
    if (hasRestrictedWallTopology(s))
      throw new ProtocolError({
        code: "INCOMPLETE_RESULT",
        message: "Exact collision validation is unavailable in this player context.",
        retryable: false,
      });
  }
  const token = s.getEmbeddedCollection("Token").get(input.tokenId);
  if (!token)
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: `Token "${input.tokenId}" not found.`,
      retryable: false,
      fieldPath: "tokenId",
    });
  const d = data(token);
  const sceneData = data(s);
  return {
    token: {
      x: Number(d["x"] ?? 0),
      y: Number(d["y"] ?? 0),
      elevation: Number(d["elevation"] ?? 0),
      revision: genuineRevision(d, "tokenId"),
      sceneRevision: genuineRevision(sceneData, "sceneId"),
      width: Number(d["width"] ?? 1) * s.grid.size,
      height: Number(d["height"] ?? 1) * s.grid.size,
    },
    walls: walls(s, game.user.isGM),
    grid: { type: s.grid.type, size: s.grid.size, diagonalRule: diagonalRule(s) },
    fog: fogEvidence(input.sceneId),
  };
}
export function validateLiveTokenPath(input: ValidateTokenPathInput): ValidateTokenPathResult {
  const before = liveRead(input);
  const result = validatePathGeometry(input, before.token, before.walls, before.grid);
  const after = liveRead(input);
  const afterProjection = validatePathGeometry(input, after.token, after.walls, after.grid);
  const beforeEvidence = { ...result.evidence.before, fog: before.fog };
  const afterEvidence = { ...afterProjection.evidence.before, fog: after.fog };
  const unchanged = stable(beforeEvidence) === stable(afterEvidence);
  result.evidence = {
    before: beforeEvidence,
    after: afterEvidence,
    unchanged,
    independentReadRequired: true,
  };
  result.after = {
    x: after.token.x,
    y: after.token.y,
    elevation: after.token.elevation,
    revision: after.token.revision,
  };
  if (!unchanged) {
    result.reachable = false;
    if (result.status !== "unsupported") result.status = "incomplete";
    result.incompleteReasons.push(
      "Scene, Token, Wall/door, or fog state changed between the two live reads.",
    );
  }
  return result;
}
export function validateLiveWallTopology(input: ValidateWallTopologyInput): WallTopologyResult {
  const s = scene(input.sceneId);
  assertScenePermission(s);
  if (!game.user.isGM)
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "Wall topology with exact wall identifiers requires a GM execution lane.",
      retryable: false,
      fieldPath: "sceneId",
    });
  return inspectWallTopology(input.sceneId, walls(s, true));
}
registerCommand(COLLISION_COMMANDS.VALIDATE_PATH, validateLiveTokenPath);
registerCommand(COLLISION_COMMANDS.VALIDATE_TOPOLOGY, validateLiveWallTopology);
