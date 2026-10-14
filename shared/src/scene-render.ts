export const SCENE_RENDER_COMMANDS = {
  SNAPSHOT: "sceneRenderSnapshot",
  VISIBILITY: "sceneVisibilityInspect",
} as const;

export const SCENE_RENDER_LIMITS = {
  maxImageBytes: 2_000_000,
  maxQueryPoints: 500,
  maxVisiblePerKind: 500,
  maxRegions: 250,
  maxRegionCandidates: 1_000,
  maxBarriers: 500,
  maxCoverageSources: 100,
  maxCoveragePointsPerSource: 512,
  maxIssues: 50,
} as const;

export interface SceneRenderInput {
  sceneId: string;
  effectiveUserId: string;
  /** The owned Token whose vision context must be used. No implicit Token is selected. */
  tokenId: string;
  includeImage?: boolean | undefined;
  maxImageBytes?: number | undefined;
  queryPoints?: Array<{ id: string; x: number; y: number; elevation?: number }> | undefined;
}

export type SceneRenderStatus = "complete" | "incomplete" | "asset_error" | "unsupported";

export type SceneRenderIssueCode =
  | "ASSET_CAPTURE_FAILED"
  | "ASSET_CAPTURE_UNAVAILABLE"
  | "ASSET_LIMIT_EXCEEDED"
  | "BARRIER_LIMIT_REACHED"
  | "COVERAGE_LIMIT_REACHED"
  | "DARKNESS_UNAVAILABLE"
  | "FOG_UNAVAILABLE"
  | "LIGHTING_UNAVAILABLE"
  | "PERSISTENCE_CHANGED"
  | "QUERY_FAILED"
  | "REGION_EVIDENCE_INCOMPLETE"
  | "REGION_LIMIT_REACHED"
  | "REGION_SUPPORT_UNAVAILABLE"
  | "SELECTED_VISION_EVALUATION_FAILED"
  | "SELECTED_VISION_ISOLATION_INCOMPLETE"
  | "SELECTED_VISION_ISOLATION_UNAVAILABLE"
  | "TOKEN_VISION_INACTIVE"
  | "VISIBILITY_API_UNAVAILABLE"
  | "VISIBLE_ENTITY_LIMIT_REACHED";

export interface SceneRenderIssue {
  code: SceneRenderIssueCode;
  message: string;
  retryable: boolean;
  subjectId?: string | undefined;
}

export interface SceneVisibilityResult {
  capturedAt: string;
  observation: {
    version: 1; id: string; worldId: string; sceneId: string; userId: string; tokenId: string;
    actorId: string | null; clientId: string | null; isGM: false; optedIn: true;
    capturedAt: string; stateRevision: string; readiness: "ready" | "stale" | "unavailable";
    basis: "request-local-native-render-flags"; pendingRenderFlags: number | null;
  };
  sceneId: string;
  effectiveUserId: string;
  tokenId: string;
  status: SceneRenderStatus;
  issues: SceneRenderIssue[];
  context: {
    selectedUser: true;
    selectedToken: true;
    tokenOwned: true;
    sceneLoaded: true;
  };
  /** Only entities actually rendered to the selected client are disclosed. */
  visible: { tokens: string[]; notes: string[]; tiles: string[] };
  /** Hidden/occluded identities and counts are intentionally not disclosed. */
  redaction: {
    occludedEntities: true;
    hiddenRegions: true;
    barrierDocumentIds: true;
    barrierCoordinates: true;
    secretDoors: true;
    exitDestinations: true;
  };
  queryPoints: Array<{
    id: string;
    visible: boolean;
    regions: string[];
    blockerAttribution:
      "none" | "visible-wall" | "out-of-range" | "environment-ambiguous" | "unavailable";
    /** Response-local opaque barrier keys only; document IDs and coordinates remain redacted. */
    blockerKeys: string[];
  }>;
  effectiveSources: { vision: 0 | 1; light: number };
  isolation: {
    status: "complete" | "incomplete" | "unsupported";
    method: "foundry-v14-detection-modes" | "selected-source-polygons" | null;
    detectionModes: number;
    unrelatedVisionSourcesIgnored: number;
    visionProvidingLightsIgnored: number;
  };
  environment: {
    fog: "complete" | "incomplete" | "unsupported";
    lighting: "complete" | "incomplete" | "unsupported";
    darkness: "complete" | "incomplete" | "unsupported";
    vision: "complete" | "incomplete" | "unsupported";
    regions: "complete" | "incomplete" | "unsupported";
    fogExplorationEnabled: boolean | null;
    tokenVisionEnabled: boolean | null;
    globalLight: boolean | null;
    darknessLevel: number | null;
  };
  /** Player-visible Regions use response-local opaque keys; names, IDs, and behavior details are never sent. */
  regions: Array<{
    key: string;
    /** Foundry's prepared Region membership for the selected owned Token. */
    containsSelectedToken: boolean;
    /** Only a bounded presence bit is disclosed; behavior identities, types, and configuration stay redacted. */
    effects: "active" | "none" | "redacted";
  }>;
  /** Player-visible doors/barriers use response-local opaque keys and never include coordinates or destinations. */
  visibleBarriers: Array<{
    key: string;
    kind: "barrier" | "door";
    state: "open" | "closed" | "locked" | "unknown";
    blocksVision: boolean;
    exit: boolean;
    destination: "redacted";
  }>;
  coveragePolygons: Array<{
    source: "selected-token";
    points: Array<{ x: number; y: number }>;
  }>;
  fogRevision: string | null;
  persistence: { beforeRevision: string; afterRevision: string; unchanged: boolean };
  bounds: {
    truncated: boolean;
    visiblePerKind: number;
    regions: number;
    barriers: number;
    coverageSources: number;
    coveragePointsPerSource: number;
    issues: number;
  };
}

export interface SceneRenderResult extends SceneVisibilityResult {
  capturedAt: string;
  image: { mediaType: "image/png" | "image/webp"; dataUrl: string; bytes: number } | null;
}
