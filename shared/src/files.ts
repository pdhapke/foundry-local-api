// Phase 24 — File/Asset Management. Command names and payload/result shapes
// for browsing Foundry's `FilePicker` directories, uploading files, and
// creating directories, shared between the server's file endpoints
// (server/src/endpoints/files.ts) and the module's command handlers
// (module/src/commands/files.ts).
//
// Upload content travels as base64 in the JSON payload (the bridge protocol
// is JSON-only end to end — see shared/src/protocol.ts — there's no
// multipart/binary channel), which the module decodes into a real `File`
// before handing it to Foundry's own `FilePicker.upload()`. Foundry's own
// server enforces the actual upload security model (allowed extensions,
// size limits, GM-only for some sources) — this phase is a pass-through to
// that real API, not a reimplementation of its rules.

export const FILE_COMMANDS = {
  BROWSE: "fileBrowse",
  UPLOAD: "fileUpload",
  CREATE_DIRECTORY: "fileCreateDirectory",
} as const;

/** A `FilePicker` storage source, e.g. "data" (the default, the world's Data directory), "public", or "s3". */
export interface FileBrowseInput {
  source?: string | undefined;
  /** Directory path to list, relative to the source root. Defaults to the root. */
  target?: string | undefined;
}

export interface FileBrowseResult {
  target: string;
  source: string;
  dirs: string[];
  files: string[];
}

export interface FileUploadInput {
  source?: string | undefined;
  /** Destination directory path, relative to the source root. */
  path: string;
  fileName: string;
  /** Base64-encoded file content (no `data:` URI prefix). */
  contentBase64: string;
  mimeType?: string | undefined;
}

export interface FileUploadResult {
  /** The uploaded file's path as returned by Foundry. */
  path: string;
}

export interface CreateDirectoryInput {
  source?: string | undefined;
  /** Directory path to create, relative to the source root. */
  target: string;
}

export interface CreateDirectoryResult {
  target: string;
}
