export const ASSET_COMMANDS = {
  REFERENCES: "assets.references",
} as const;

export type AssetCollisionPolicy = "fail" | "replace-same-hash";
export type AssetOwnership = { scope: "fixture"; testRunId: string } | { scope: "campaign" };

export interface AssetLocation {
  root: string;
  path: string;
}
export interface AssetReferenceInput {
  path: string;
}
export interface AssetReference {
  documentUuid: string;
  fieldPath: string;
}
export interface AssetReferenceResult {
  path: string;
  references: AssetReference[];
  complete: boolean;
  warnings: string[];
}
export interface AssetStatInput extends AssetLocation {
  expectedHash?: string;
}
export interface AssetStatResult extends AssetLocation {
  exists: boolean;
  size?: number;
  sha256?: string;
  mediaType?: string;
  /** True only when the bounded parser validated the supported container structure. */
  structurallyValid?: boolean;
  metadata?: {
    format: string;
    codec: string;
    width?: number;
    height?: number;
    channels?: number;
    sampleRate?: number;
    bitsPerSample?: number;
    durationSeconds?: number;
  };
  /** Reserved for a genuine codec decode/playback check; structural parsing alone is false. */
  decodable?: boolean;
}
export interface AssetMoveInput {
  source: AssetLocation;
  destination: AssetLocation;
  expectedHash: string;
  collisionPolicy: AssetCollisionPolicy;
  ownership: AssetOwnership;
}
export interface AssetDeleteInput extends AssetLocation {
  expectedHash: string;
  ownership: AssetOwnership;
  requireUnreferenced: true;
}
export interface AssetMutationResult {
  source?: AssetLocation;
  target: AssetLocation;
  sha256: string;
  alreadyAbsent: boolean;
  references: AssetReference[];
}
