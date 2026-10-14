import type { Buffer } from "node:buffer";

/** Public types for the existing shared bootstrap; this declaration changes no runtime behavior. */
export interface ManagedCredentialRecord {
  version: 1;
  generation: number;
  key: string;
}

export interface ManagedCredentialReplacementOptions {
  directory?: string;
  initialize?: boolean;
  recover?: boolean;
  random?: (size: number) => Buffer;
}

export declare const managedDirectory: string;
export declare function readManagedCredential(directory?: string): ManagedCredentialRecord | null;
export declare function replaceManagedCredential(options?: ManagedCredentialReplacementOptions): {
  generation: number;
};
