// Phase 24 — File/Asset Management command handlers. Registered against the
// same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// Every handler here is a thin pass-through to Foundry's own `FilePicker`
// API — Foundry's server (not this one) enforces the real upload security
// model (allowed extensions, size limits, per-source permissions). Upload
// content arrives as base64 (see shared/src/files.ts's header comment for
// why) and is decoded into a real `File` before being handed to
// `FilePicker.upload()`.
import {
  FILE_COMMANDS,
  type CreateDirectoryInput,
  type CreateDirectoryResult,
  type FileBrowseInput,
  type FileBrowseResult,
  type FileUploadInput,
  type FileUploadResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

const DEFAULT_SOURCE = "data";

function base64ToFile(contentBase64: string, fileName: string, mimeType: string | undefined): File {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], fileName, mimeType ? { type: mimeType } : undefined);
}

registerCommand(
  FILE_COMMANDS.BROWSE,
  ({ source, target }: FileBrowseInput): Promise<FileBrowseResult> =>
    FilePicker.browse(source ?? DEFAULT_SOURCE, target ?? ""),
);

registerCommand(
  FILE_COMMANDS.UPLOAD,
  async ({
    source,
    path,
    fileName,
    contentBase64,
    mimeType,
  }: FileUploadInput): Promise<FileUploadResult> => {
    const file = base64ToFile(contentBase64, fileName, mimeType);
    const result = await FilePicker.upload(source ?? DEFAULT_SOURCE, path, file);
    if (!result) {
      throw new Error(`Failed to upload "${fileName}" to "${path}"`);
    }
    return result;
  },
);

registerCommand(
  FILE_COMMANDS.CREATE_DIRECTORY,
  async ({ source, target }: CreateDirectoryInput): Promise<CreateDirectoryResult> => {
    await FilePicker.createDirectory(source ?? DEFAULT_SOURCE, target);
    return { target };
  },
);
