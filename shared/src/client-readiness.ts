export const CLIENT_READINESS_COMMANDS = {
  PRELOAD: "clientPreloadScene",
  GET: "clientReadinessGet",
  APPLY_VIEWPORT: "clientViewportApply",
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
}
