/** Local canvas operations, exclusively on an authenticated, consenting TV client. */
export const GM_TV_COMMANDS = { EXECUTE: "gmTvControl" } as const;
export const TV_CONTROL_VERSION = "tv-controls-v1" as const;

export interface TvCameraState {
  sceneId: string;
  x: number;
  y: number;
  scale: number;
}
export interface TvControlInput {
  version: typeof TV_CONTROL_VERSION;
  worldId: string;
  sceneId: string;
  tvUserId: string;
  tvClientId: string;
  /** Selects an existing authenticated GM lane; this identifier never grants authority. */
  requestingUserId: string;
  action: "inspect" | "unionVision" | "camera" | "calibrate" | "perspective";
  camera?: { x: number; y: number; scale: number } | undefined;
  /** Pixels are CSS pixels of the ruler sample on this exact TV display. */
  calibration?:
    | {
        measuredPixels: number;
        measuredInches: number;
        gridInches: number;
        rulerConfirmed: true;
      }
    | undefined;
  perspective?: "native-top-down" | undefined;
  expectedState?: TvCameraState | undefined;
  idempotencyKey?: string | undefined;
}
export type TvControlCommandInput = TvControlInput;
export interface TvControlResult {
  version: typeof TV_CONTROL_VERSION;
  worldId: string;
  tvUserId: string;
  tvClientId: string;
  action: TvControlInput["action"];
  camera: TvCameraState;
  vision: {
    mode: "native-pc-union";
    status: "verified" | "blocked";
    blockedReason: string | null;
    sourceCount: number;
    nativeWallsFogDetection: true;
    permissionsChanged: false;
  };
  perspective: "native-top-down";
  calibration: { physicalVerified: false; rulerAcceptanceRequired: true };
  replayed: boolean;
}
export interface TvControlExecutionResult extends TvControlResult {
  requestingUserId: string;
  auditCorrelationId: string;
  executingClient: { clientId: string; userId: string; lane: "tv" };
}
