export const CLIENT_READINESS_COMMANDS = {
  PRELOAD: "clientPreloadScene",
  GET: "clientReadinessGet",
  APPLY_VIEWPORT: "clientViewportApply",
  RELOAD: "clientReload",
  ADOPT_IDENTITY: "clientIdentityAdopt",
  ADOPT_ENROLLED_IDENTITY: "clientEnrolledIdentityAdopt",
} as const;

export interface ClientTargetInput {
  clientId?: string | undefined;
  userId?: string | undefined;
}

export interface ClientPreloadInput {
  sceneId: string;
  assetPaths: string[];
  correlationId: string;
  timeoutMs: number;
}

export interface ClientAssetReadiness {
  path: string;
  status: "loaded" | "failed";
  error?: string | undefined;
}

export interface ClientReadinessResult {
  correlationId: string;
  acknowledged: true;
  replayed: boolean;
  acknowledgedAt: string;
  clientUserId: string;
  executingClientId: string;
  expectedSceneId: string | null;
  activeSceneId: string | null;
  scenePreloaded: boolean;
  activeSceneMatches: boolean;
  sceneReady: boolean;
  display?: { cssWidth: number; cssHeight: number; devicePixelRatio: number; canvasReady: boolean;
    fullscreen?: boolean | undefined; windowWidth?: number | undefined; windowHeight?: number | undefined; screenWidth?: number | undefined; screenHeight?: number | undefined; visualScale?: number | undefined } | undefined;
  assets: ClientAssetReadiness[];
  viewport: { x: number; y: number; scale: number } | null;
  applied: { preload: boolean; viewport: boolean };
  warnings: string[];
  incomplete: boolean;
}

export interface ClientReadinessInput {
  correlationId: string;
}

export interface ClientViewportInput {
  correlationId: string;
  sceneId: string;
  viewport: { x: number; y: number; scale: number };
  /** Explicit GM command to view this scene on the exact opted-in receiver. */
  viewScene?: boolean | undefined;
  /** Use the installed Digital Tabletop calibration, with fullscreen preflight. */
  digitalTabletop?: boolean | undefined;
}

export interface ClientReloadInput {
  correlationId: string;
  delayMs: number;
}

export interface ClientReloadResult {
  correlationId: string;
  acknowledged: true;
  replayed: boolean;
  acknowledgedAt: string;
  clientUserId: string;
  executingClientId: string;
  reloadScheduled: true;
  reloadAfterMs: number;
}

export interface ClientIdentityAdoptionInput {
  correlationId: string;
  expectedClientId: string;
  desiredClientId: string;
}

/** Internal bridge command payload; the proof is never accepted from or projected to REST/MCP callers. */
export interface ClientIdentityAdoptionCommandInput extends ClientIdentityAdoptionInput {
  identityHandoffProof: string;
}

export interface ClientIdentityAdoptionResult {
  correlationId: string;
  acknowledged: true;
  replayed: boolean;
  acknowledgedAt: string;
  clientUserId: string;
  executingClientId: string;
  adoptedClientId: string;
  reloadRequired: true;
}

export interface ClientEnrolledIdentityAdoptionInput extends ClientIdentityAdoptionInput {
  expectedUserId: string;
  expectedLane: "player" | "tv";
}

export interface ClientEnrolledIdentityAdoptionCommandInput extends ClientEnrolledIdentityAdoptionInput {
  identityHandoffProof: string;
}
