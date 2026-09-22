// Phase 24 — File/Asset Management.
//
// Browse/upload/create-directory against Foundry's `FilePicker`, hand-rolled
// (no generic factory applies — this isn't Document CRUD). Upload content
// travels as base64 in the JSON body; see shared/src/files.ts's header
// comment for why. See module/src/commands/files.ts for the matching
// module-side handlers, which are a thin pass-through to Foundry's own
// `FilePicker` API and its real upload security model.
import { z } from "zod";

import {
  FILE_COMMANDS,
  type CreateDirectoryInput,
  type CreateDirectoryResult,
  type FileBrowseInput,
  type FileBrowseResult,
  type FileUploadInput,
  type FileUploadResult,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const browseSchema = z.object({
  source: z.string().min(1).optional(),
  target: z.string().optional(),
});

const uploadSchema = z.object({
  source: z.string().min(1).optional(),
  path: z.string(),
  fileName: z.string().min(1),
  contentBase64: z.string().min(1),
  mimeType: z.string().min(1).optional(),
});

const createDirectorySchema = z.object({
  source: z.string().min(1).optional(),
  target: z.string().min(1),
});

const browseDescriptor: EndpointDescriptor<FileBrowseInput, FileBrowseResult> = {
  name: "foundry_browse_files",
  description:
    'Lists the directories and files under a FilePicker path (default source "data", default target the root).',
  method: "get",
  path: "/files/browse",
  inputSchema: browseSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<FileBrowseInput, FileBrowseResult>(FILE_COMMANDS.BROWSE, input),
};

const uploadDescriptor: EndpointDescriptor<FileUploadInput, FileUploadResult> = {
  name: "foundry_upload_file",
  description:
    "Uploads a file (base64-encoded content) to a FilePicker directory, subject to Foundry's own " +
    "upload security model (allowed extensions, size limits, source permissions).",
  method: "post",
  path: "/files/upload",
  inputSchema: uploadSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<FileUploadInput, FileUploadResult>(FILE_COMMANDS.UPLOAD, input),
};

const createDirectoryDescriptor: EndpointDescriptor<CreateDirectoryInput, CreateDirectoryResult> = {
  name: "foundry_create_file_directory",
  description: "Creates a new directory under a FilePicker source.",
  method: "post",
  path: "/files/directories",
  inputSchema: createDirectorySchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<CreateDirectoryInput, CreateDirectoryResult>(
      FILE_COMMANDS.CREATE_DIRECTORY,
      input,
    ),
};

export const fileEndpointDescriptors: AnyEndpointDescriptor[] = [
  browseDescriptor,
  uploadDescriptor,
  createDirectoryDescriptor,
];
