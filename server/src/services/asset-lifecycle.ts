import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  ProtocolError,
  type AssetDeleteInput,
  type AssetLocation,
  type AssetMoveInput,
  type AssetMutationResult,
  type AssetOwnership,
  type AssetReferenceResult,
  type AssetStatResult,
} from "@foundry-local-api/shared";

export interface AssetLifecycleOptions {
  roots: Record<string, string>;
  protectedPrefixes?: Record<string, string[]>;
  campaignOwnedPrefixes?: Record<string, string[]>;
  /** Parent directories whose immediate child is the exact testRunId namespace. */
  fixtureOwnedPrefixes?: Record<string, string[]>;
  /** Resolve against the durable fixture registry on every request. */
  isFixtureTestRunId?: (testRunId: string) => boolean | Promise<boolean>;
  /** Test/diagnostic hook reporting each bounded media-parser read request. */
  observeMediaRead?: (requestedBytes: number) => void;
}

interface SafeMediaMetadata {
  format: "png" | "jpeg" | "webp" | "wav" | "ogg";
  codec: string;
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  durationSeconds?: number;
}

type AssetInspectionResult = AssetStatResult & {
  modifiedTimeMs?: number;
  metadata?: SafeMediaMetadata;
};

const MAX_MEDIA_READ = 64 * 1024;
const MAX_MEDIA_CHUNKS = 16_384;
type OpenFile = Awaited<ReturnType<typeof open>>;

interface MediaInspection {
  mediaType?: string;
  decodable: boolean;
  structurallyValid?: boolean;
  metadata?: SafeMediaMetadata;
}

export class AssetLifecycleService {
  constructor(private readonly options: AssetLifecycleOptions) {}
  private root(id: string): string {
    const value = this.options.roots[id];
    if (!value)
      throw new ProtocolError({
        code: "PROTECTED_PATH",
        message: "Unknown asset root.",
        retryable: false,
        fieldPath: "root",
      });
    return path.resolve(value);
  }
  private resolve(location: AssetLocation): string {
    if (!location.path || path.isAbsolute(location.path) || location.path.includes("\0"))
      throw new ProtocolError({
        code: "PROTECTED_PATH",
        message: "Asset path must be a non-empty relative path.",
        retryable: false,
        fieldPath: "path",
      });
    const root = this.root(location.root);
    const target = path.resolve(root, location.path);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new ProtocolError({
        code: "PROTECTED_PATH",
        message: "Asset path escapes its allowlisted root.",
        retryable: false,
        fieldPath: "path",
      });
    const normalized = relative.replaceAll("\\", "/");
    if (
      (this.options.protectedPrefixes?.[location.root] ?? []).some((prefix) =>
        matchesPathPrefix(normalized, prefix),
      )
    )
      throw new ProtocolError({
        code: "PROTECTED_PATH",
        message: "Asset path is protected.",
        retryable: false,
        fieldPath: "path",
      });
    return target;
  }
  private normalizedRelative(location: AssetLocation): string {
    return path.relative(this.root(location.root), this.resolve(location)).replaceAll("\\", "/");
  }
  private async assertOwned(location: AssetLocation, ownership: AssetOwnership): Promise<void> {
    const normalized = this.normalizedRelative(location);
    if (ownership.scope === "fixture") {
      const fixturePrefixes = this.options.fixtureOwnedPrefixes?.[location.root] ?? ["fixtures"];
      if (
        !/^[A-Za-z0-9_-]{4,128}$/.test(ownership.testRunId) ||
        !this.options.isFixtureTestRunId ||
        !(await this.options.isFixtureTestRunId(ownership.testRunId)) ||
        !fixturePrefixes.some((prefix) =>
          normalized.startsWith(`${prefix.replace(/\/$/, "")}/${ownership.testRunId}/`),
        )
      )
        throw new ProtocolError({
          code: "PERMISSION_DENIED",
          message: "Fixture ownership does not match an exact recorded test run namespace.",
          retryable: false,
        });
      return;
    }
    if (
      !(this.options.campaignOwnedPrefixes?.[location.root] ?? []).some((prefix) =>
        normalized.startsWith(`${prefix.replace(/\/$/, "")}/`),
      )
    )
      throw new ProtocolError({
        code: "PERMISSION_DENIED",
        message: "Campaign asset ownership could not be proven.",
        retryable: false,
      });
  }
  private async hash(file: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  }
  /** Reject every existing symlink/junction component and verify its real path stays in-root. */
  private async assertSafePath(location: AssetLocation): Promise<void> {
    const root = this.root(location.root);
    const file = this.resolve(location);
    const relative = path.relative(root, file);
    const components = relative === "" ? [] : relative.split(path.sep);
    let rootReal: string;
    try {
      const rootInfo = await lstat(root);
      if (rootInfo.isSymbolicLink()) this.throwSymlink("Asset root is a symbolic link.");
      rootReal = await realpath(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProtocolError({
          code: "PROTECTED_PATH",
          message: "Configured asset root does not exist.",
          retryable: false,
          fieldPath: "root",
        });
      }
      throw error;
    }
    if (!samePath(root, rootReal)) this.throwSymlink("Asset root resolves through a redirect.");

    let cursor = root;
    for (const component of components) {
      cursor = path.join(cursor, component);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) this.throwSymlink("Symbolic-link asset path component refused.");
        const actual = await realpath(cursor);
        if (!isWithin(rootReal, actual))
          this.throwSymlink("Asset path component resolves outside its allowlisted root.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }
  private throwSymlink(message: string): never {
    throw new ProtocolError({
      code: "PROTECTED_PATH",
      message,
      retryable: false,
      fieldPath: "path",
    });
  }
  private assertCompleteReferences(references: AssetReferenceResult, expectedPath: string): void {
    let scanMatchesTarget = false;
    try {
      scanMatchesTarget =
        normalizeReferencePath(references?.path) === normalizeReferencePath(expectedPath);
    } catch {
      scanMatchesTarget = false;
    }
    if (
      !references ||
      references.complete !== true ||
      !Array.isArray(references.references) ||
      !Array.isArray(references.warnings) ||
      !scanMatchesTarget
    )
      throw new ProtocolError({
        code: "INCOMPLETE_RESULT",
        message: "Asset mutation refused because the reference scan was incomplete.",
        retryable: true,
        details: {
          warningCount: Array.isArray(references?.warnings) ? references.warnings.length : 0,
          pathMatched: scanMatchesTarget,
        },
      });
  }
  private async ensureSafeParentDirectories(location: AssetLocation): Promise<void> {
    const root = this.root(location.root);
    const target = this.resolve(location);
    const parent = path.dirname(target);
    const relative = path.relative(root, parent);
    if (relative === "") return;
    let cursor = root;
    for (const component of relative.split(path.sep)) {
      cursor = path.join(cursor, component);
      try {
        await mkdir(cursor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink())
        this.throwSymlink("Asset destination ancestor is not a safe directory.");
      const actual = await realpath(cursor);
      const rootReal = await realpath(root);
      if (!isWithin(rootReal, actual))
        this.throwSymlink("Asset destination ancestor resolves outside its allowlisted root.");
    }
  }
  async inspect(input: AssetLocation): Promise<AssetInspectionResult> {
    let file: string;
    try {
      file = this.resolve(input);
    } catch (error) {
      if (error instanceof URIError)
        throw new ProtocolError({
          code: "INVALID_PAYLOAD",
          message: "Asset path encoding is invalid.",
          retryable: false,
          fieldPath: "path",
        });
      throw error;
    }
    await this.assertSafePath(input);
    try {
      const info = await stat(file);
      if (!info.isFile())
        throw new ProtocolError({
          code: "INVALID_PAYLOAD",
          message: "Asset target is not a file.",
          retryable: false,
        });
      const handle = await open(file, "r");
      let media: MediaInspection;
      try {
        media = await inspectMedia(handle, info.size, this.options.observeMediaRead);
      } finally {
        await handle.close();
      }
      return {
        ...input,
        exists: true,
        size: info.size,
        modifiedTimeMs: info.mtimeMs,
        sha256: await this.hash(file),
        ...(media.mediaType ? { mediaType: media.mediaType } : {}),
        decodable: media.decodable,
        ...(media.structurallyValid === undefined
          ? {}
          : { structurallyValid: media.structurallyValid }),
        ...(media.metadata ? { metadata: media.metadata } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...input, exists: false };
      throw error;
    }
  }

  /** Bounded reference-audit check that avoids hashing and media parsing. */
  async exists(input: AssetLocation): Promise<boolean> {
    const file = this.resolve(input);
    await this.assertSafePath(input);
    try {
      return (await stat(file)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async move(
    input: AssetMoveInput,
    references: AssetReferenceResult,
  ): Promise<AssetMutationResult> {
    this.assertCompleteReferences(references, input.source.path);
    if (references.references.length) {
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message:
          "Referenced asset move was refused because reference rewriting is outside this operation's atomic scope.",
        retryable: false,
        details: { referenceCount: references.references.length },
      });
    }
    await this.assertOwned(input.source, input.ownership);
    await this.assertOwned(input.destination, input.ownership);
    const source = this.resolve(input.source),
      target = this.resolve(input.destination);
    if (samePath(source, target))
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: "Asset source and destination must be different paths.",
        retryable: false,
        fieldPath: "destination.path",
      });
    await this.assertSafePath(input.source);
    await this.assertSafePath(input.destination);
    const sourceInfo = await this.inspect(input.source);
    const destinationInfo = await this.inspect(input.destination);
    if (!sourceInfo.exists) {
      if (destinationInfo.exists && destinationInfo.sha256 === input.expectedHash)
        return {
          source: input.source,
          target: input.destination,
          sha256: input.expectedHash,
          alreadyAbsent: true,
          references: references.references,
        };
      throw new ProtocolError({
        code: destinationInfo.exists ? "HASH_MISMATCH" : "NOT_FOUND",
        message: destinationInfo.exists
          ? "Move replay destination does not match expectedHash."
          : "Move source and replay destination are both absent.",
        retryable: false,
        fieldPath: destinationInfo.exists ? "destination.path" : "source.path",
      });
    }
    const actual = sourceInfo.sha256!;
    if (actual !== input.expectedHash)
      throw new ProtocolError({
        code: "HASH_MISMATCH",
        message: "Source hash does not match expectedHash.",
        retryable: true,
      });
    if (
      destinationInfo.exists &&
      (input.collisionPolicy === "fail" || destinationInfo.sha256 !== actual)
    )
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: "Destination collision refused.",
        retryable: false,
      });
    if (!destinationInfo.exists) {
      await this.ensureSafeParentDirectories(input.destination);
      await this.assertSafePath(input.destination);
      await rename(source, target);
    } else await rm(source);
    return {
      source: input.source,
      target: input.destination,
      sha256: actual,
      alreadyAbsent: false,
      references: references.references,
    };
  }
  async delete(
    input: AssetDeleteInput,
    references: AssetReferenceResult,
  ): Promise<AssetMutationResult> {
    this.assertCompleteReferences(references, input.path);
    await this.assertOwned(input, input.ownership);
    if (references.references.length)
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: "Referenced asset deletion was refused.",
        retryable: false,
        details: { referenceCount: references.references.length },
      });
    const file = this.resolve(input);
    await this.assertSafePath(input);
    const inspected = await this.inspect(input);
    if (!inspected.exists)
      return {
        target: { root: input.root, path: input.path },
        sha256: input.expectedHash,
        alreadyAbsent: true,
        references: [],
      };
    if (inspected.sha256 !== input.expectedHash)
      throw new ProtocolError({
        code: "HASH_MISMATCH",
        message: "Asset hash does not match expectedHash.",
        retryable: true,
      });
    await rm(file);
    return {
      target: { root: input.root, path: input.path },
      sha256: input.expectedHash,
      alreadyAbsent: false,
      references: [],
    };
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeReferencePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid path");
  const decoded = decodeURIComponent(value).replaceAll("\\", "/").replace(/^\/+/, "");
  return path.posix.normalize(decoded).replace(/^\.\//, "");
}

async function readBounded(
  handle: OpenFile,
  position: number,
  length: number,
  observe?: (requestedBytes: number) => void,
): Promise<Buffer | null> {
  if (!Number.isSafeInteger(position) || position < 0 || length < 0 || length > MAX_MEDIA_READ)
    return null;
  observe?.(length);
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) return null;
    offset += bytesRead;
  }
  return buffer;
}

async function inspectMedia(
  handle: OpenFile,
  size: number,
  observe?: (requestedBytes: number) => void,
): Promise<MediaInspection> {
  const signature = await readBounded(handle, 0, Math.min(12, size), observe);
  if (!signature) return { decodable: false };
  if (signature.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return inspectPng(handle, size, observe);
  if (signature[0] === 0xff && signature[1] === 0xd8) return inspectJpeg(handle, size, observe);
  if (signature.subarray(0, 4).toString("ascii") === "RIFF") {
    const formType = signature.subarray(8, 12).toString("ascii");
    if (formType === "WEBP") return inspectWebp(handle, size, observe);
    if (formType === "WAVE") return inspectWav(handle, size, observe);
    return { decodable: false };
  }
  if (signature.subarray(0, 4).toString("ascii") === "OggS")
    return inspectOgg(handle, size, observe);
  return { decodable: false };
}

function readUInt24LE(value: Buffer, offset: number): number {
  return (value[offset] ?? 0) | ((value[offset + 1] ?? 0) << 8) | ((value[offset + 2] ?? 0) << 16);
}

async function inspectWebp(
  handle: OpenFile,
  size: number,
  observe?: (requestedBytes: number) => void,
): Promise<MediaInspection> {
  const failed: MediaInspection = { mediaType: "image/webp", decodable: false };
  const riff = await readBounded(handle, 0, 12, observe);
  if (!riff || riff.subarray(8, 12).toString("ascii") !== "WEBP") return failed;
  if (riff.readUInt32LE(4) + 8 !== size) return failed;

  let offset = 12;
  let width = 0;
  let height = 0;
  let codec: string | undefined;
  let sawImagePayload = false;
  let sawAnimation = false;
  for (let count = 0; count < MAX_MEDIA_CHUNKS && offset + 8 <= size; count++) {
    const header = await readBounded(handle, offset, 8, observe);
    if (!header) return failed;
    const type = header.subarray(0, 4).toString("ascii");
    const length = header.readUInt32LE(4);
    const end = offset + 8 + length + (length % 2);
    if (!Number.isSafeInteger(end) || end > size) return failed;

    if (type === "VP8X") {
      if (length !== 10 || width !== 0 || height !== 0) return failed;
      const extended = await readBounded(handle, offset + 8, 10, observe);
      if (!extended || extended[1] !== 0 || extended[2] !== 0 || extended[3] !== 0) return failed;
      width = readUInt24LE(extended, 4) + 1;
      height = readUInt24LE(extended, 7) + 1;
      codec = (extended[0]! & 0x02) !== 0 ? "webp-animation" : "webp-container";
    } else if (type === "VP8 ") {
      if (length < 10 || sawImagePayload) return failed;
      const frame = await readBounded(handle, offset + 8, 10, observe);
      if (!frame || !frame.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return failed;
      const frameWidth = frame.readUInt16LE(6) & 0x3fff;
      const frameHeight = frame.readUInt16LE(8) & 0x3fff;
      if (frameWidth === 0 || frameHeight === 0) return failed;
      if ((width !== 0 && width !== frameWidth) || (height !== 0 && height !== frameHeight))
        return failed;
      width = frameWidth;
      height = frameHeight;
      codec = "vp8";
      sawImagePayload = true;
    } else if (type === "VP8L") {
      if (length < 5 || sawImagePayload) return failed;
      const frame = await readBounded(handle, offset + 8, 5, observe);
      if (!frame || frame[0] !== 0x2f) return failed;
      const bits = frame.readUInt32LE(1);
      if (bits >>> 28 !== 0) return failed;
      const frameWidth = (bits & 0x3fff) + 1;
      const frameHeight = ((bits >>> 14) & 0x3fff) + 1;
      if ((width !== 0 && width !== frameWidth) || (height !== 0 && height !== frameHeight))
        return failed;
      width = frameWidth;
      height = frameHeight;
      codec = "vp8l";
      sawImagePayload = true;
    } else if (type === "ANIM") {
      if (length !== 6) return failed;
      sawAnimation = true;
    } else if (type === "ANMF") {
      if (length < 16 || !sawAnimation) return failed;
      sawImagePayload = true;
    }
    offset = end;
  }
  if (offset !== size || !sawImagePayload || width === 0 || height === 0 || !codec) return failed;
  return {
    mediaType: "image/webp",
    decodable: false,
    structurallyValid: true,
    metadata: { format: "webp", codec, width, height },
  };
}

async function inspectPng(
  handle: OpenFile,
  size: number,
  observe?: (requestedBytes: number) => void,
): Promise<MediaInspection> {
  const failed: MediaInspection = { mediaType: "image/png", decodable: false };
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIdat = false;
  for (let count = 0; count < MAX_MEDIA_CHUNKS && offset + 12 <= size; count++) {
    const header = await readBounded(handle, offset, 8, observe);
    if (!header) return failed;
    const length = header.readUInt32BE(0);
    const type = header.subarray(4, 8).toString("ascii");
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > size) return failed;
    let crc = pngCrcUpdate(0xffffffff, header.subarray(4, 8));
    let remaining = length;
    let dataOffset = offset + 8;
    while (remaining > 0) {
      const data = await readBounded(
        handle,
        dataOffset,
        Math.min(remaining, MAX_MEDIA_READ),
        observe,
      );
      if (!data) return failed;
      crc = pngCrcUpdate(crc, data);
      remaining -= data.length;
      dataOffset += data.length;
    }
    const storedCrc = await readBounded(handle, offset + 8 + length, 4, observe);
    if (!storedCrc || (crc ^ 0xffffffff) >>> 0 !== storedCrc.readUInt32BE(0)) return failed;
    if (count === 0) {
      if (type !== "IHDR" || length !== 13) return failed;
      const ihdr = await readBounded(handle, offset + 8, 13, observe);
      if (!ihdr) return failed;
      width = ihdr.readUInt32BE(0);
      height = ihdr.readUInt32BE(4);
      const bitDepth = ihdr[8] ?? 0;
      const colorType = ihdr[9] ?? 255;
      const validDepth =
        (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
        (colorType === 2 && [8, 16].includes(bitDepth)) ||
        (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
        ([4, 6].includes(colorType) && [8, 16].includes(bitDepth));
      if (
        width === 0 ||
        height === 0 ||
        !validDepth ||
        ihdr[10] !== 0 ||
        ihdr[11] !== 0 ||
        (ihdr[12] !== 0 && ihdr[12] !== 1)
      )
        return failed;
    } else if (type === "IHDR") return failed;
    if (type === "IDAT") sawIdat = sawIdat || length > 0;
    if (type === "IEND") {
      if (length !== 0 || !sawIdat || end !== size) return failed;
      return {
        mediaType: "image/png",
        decodable: false,
        structurallyValid: true,
        metadata: { format: "png", codec: "deflate", width, height },
      };
    }
    offset = end;
  }
  return failed;
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

async function inspectJpeg(
  handle: OpenFile,
  size: number,
  observe?: (requestedBytes: number) => void,
): Promise<MediaInspection> {
  const failed: MediaInspection = { mediaType: "image/jpeg", decodable: false };
  if (size < 8) return failed;
  let offset = 2;
  let width = 0;
  let height = 0;
  let codec: string | undefined;
  for (let count = 0; count < MAX_MEDIA_CHUNKS && offset + 2 <= size; count++) {
    let markerBytes = await readBounded(handle, offset, 2, observe);
    if (!markerBytes || markerBytes[0] !== 0xff) return failed;
    while (markerBytes[1] === 0xff) {
      offset += 1;
      markerBytes = await readBounded(handle, offset, 2, observe);
      if (!markerBytes) return failed;
    }
    const marker = markerBytes[1]!;
    offset += 2;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const lengthBytes = await readBounded(handle, offset, 2, observe);
    if (!lengthBytes) return failed;
    const length = lengthBytes.readUInt16BE(0);
    if (length < 2 || offset + length > size) return failed;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 8) return failed;
      const frame = await readBounded(handle, offset + 2, 6, observe);
      if (!frame) return failed;
      height = frame.readUInt16BE(1);
      width = frame.readUInt16BE(3);
      const components = frame[5] ?? 0;
      if (width === 0 || height === 0 || components === 0) return failed;
      codec = marker === 0xc2 ? "progressive-dct" : "jpeg";
    }
    if (marker === 0xda) {
      if (!codec) return failed;
      const tail = await readBounded(handle, size - 2, 2, observe);
      if (!tail || tail[0] !== 0xff || tail[1] !== 0xd9) return failed;
      return {
        mediaType: "image/jpeg",
        decodable: false,
        structurallyValid: true,
        metadata: { format: "jpeg", codec, width, height },
      };
    }
    offset += length;
  }
  return failed;
}

async function inspectWav(
  handle: OpenFile,
  size: number,
  observe?: (requestedBytes: number) => void,
): Promise<MediaInspection> {
  const failed: MediaInspection = { mediaType: "audio/wav", decodable: false };
  const riff = await readBounded(handle, 0, 12, observe);
  if (!riff || riff.subarray(8, 12).toString("ascii") !== "WAVE") return failed;
  if (riff.readUInt32LE(4) + 8 !== size) return failed;
  let offset = 12;
  let metadata: SafeMediaMetadata | undefined;
  let dataBytes: number | undefined;
  for (let count = 0; count < MAX_MEDIA_CHUNKS && offset + 8 <= size; count++) {
    const header = await readBounded(handle, offset, 8, observe);
    if (!header) return failed;
    const type = header.subarray(0, 4).toString("ascii");
    const length = header.readUInt32LE(4);
    const end = offset + 8 + length + (length % 2);
    if (!Number.isSafeInteger(end) || end > size) return failed;
    if (type === "fmt ") {
      if (length < 16) return failed;
      const format = await readBounded(handle, offset + 8, 16, observe);
      if (!format) return failed;
      const audioFormat = format.readUInt16LE(0);
      const channels = format.readUInt16LE(2);
      const sampleRate = format.readUInt32LE(4);
      const byteRate = format.readUInt32LE(8);
      const blockAlign = format.readUInt16LE(12);
      const bitsPerSample = format.readUInt16LE(14);
      if (
        ![1, 3].includes(audioFormat) ||
        channels === 0 ||
        sampleRate === 0 ||
        byteRate === 0 ||
        blockAlign === 0 ||
        bitsPerSample === 0 ||
        byteRate !== sampleRate * blockAlign
      )
        return failed;
      metadata = {
        format: "wav",
        codec: audioFormat === 1 ? "pcm" : "ieee-float",
        channels,
        sampleRate,
        bitsPerSample,
      };
    } else if (type === "data") dataBytes = length;
    offset = end;
  }
  if (!metadata || dataBytes === undefined || offset !== size) return failed;
  const bytesPerSecond = metadata.sampleRate! * metadata.channels! * (metadata.bitsPerSample! / 8);
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return failed;
  metadata.durationSeconds = dataBytes / bytesPerSecond;
  return { mediaType: "audio/wav", decodable: false, structurallyValid: true, metadata };
}

async function inspectOgg(
  handle: OpenFile,
  size: number,
  observe?: (requestedBytes: number) => void,
): Promise<MediaInspection> {
  const failed: MediaInspection = { mediaType: "audio/ogg", decodable: false };
  let offset = 0;
  let serial: number | undefined;
  let sequence = 0;
  let codec: "opus" | "vorbis" | undefined;
  let channels = 0;
  let sampleRate = 0;
  let finalGranule = 0;
  let sawEos = false;
  for (let count = 0; count < MAX_MEDIA_CHUNKS && offset + 27 <= size; count++) {
    const header = await readBounded(handle, offset, 27, observe);
    if (!header || header.subarray(0, 4).toString("ascii") !== "OggS" || header[4] !== 0)
      return failed;
    const flags = header[5] ?? 0;
    const pageSerial = header.readUInt32LE(14);
    const pageSequence = header.readUInt32LE(18);
    if (count === 0) {
      if ((flags & 0x02) === 0 || pageSequence !== 0) return failed;
      serial = pageSerial;
    } else if (pageSerial !== serial || pageSequence !== sequence + 1) return failed;
    sequence = pageSequence;
    const segmentCount = header[26] ?? 0;
    const lacing = await readBounded(handle, offset + 27, segmentCount, observe);
    if (!lacing) return failed;
    const payloadLength = [...lacing].reduce((sum, value) => sum + value, 0);
    const payloadOffset = offset + 27 + segmentCount;
    const end = payloadOffset + payloadLength;
    if (end > size) return failed;
    const page = await readBounded(handle, offset, end - offset, observe);
    if (!page) return failed;
    const storedChecksum = page.readUInt32LE(22);
    page.fill(0, 22, 26);
    if (oggCrc(page) !== storedChecksum) return failed;
    if (count === 0) {
      const prefix = await readBounded(handle, payloadOffset, Math.min(payloadLength, 30), observe);
      if (!prefix) return failed;
      if (prefix.subarray(0, 8).toString("ascii") === "OpusHead" && prefix.length >= 19) {
        codec = "opus";
        channels = prefix[9] ?? 0;
        sampleRate = 48_000;
      } else if (
        prefix[0] === 1 &&
        prefix.subarray(1, 7).toString("ascii") === "vorbis" &&
        prefix.length >= 16
      ) {
        codec = "vorbis";
        channels = prefix[11] ?? 0;
        sampleRate = prefix.readUInt32LE(12);
      }
      if (codec && (channels === 0 || sampleRate === 0)) return failed;
    }
    const granule = header.readBigUInt64LE(6);
    if (granule <= BigInt(Number.MAX_SAFE_INTEGER)) finalGranule = Number(granule);
    sawEos = (flags & 0x04) !== 0;
    offset = end;
  }
  if (!codec || !sawEos || offset !== size) return failed;
  return {
    mediaType: "audio/ogg",
    decodable: false,
    structurallyValid: true,
    metadata: {
      format: "ogg",
      codec,
      channels,
      sampleRate,
      ...(finalGranule > 0 ? { durationSeconds: finalGranule / sampleRate } : {}),
    },
  };
}

function pngCrcUpdate(crc: number, bytes: Uint8Array): number {
  let value = crc >>> 0;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = (value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1) >>> 0;
  }
  return value;
}

function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++)
      crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  }
  return crc >>> 0;
}

/**
 * True when `relativePath` equals `prefix` or lies under it. A `*` segment in
 * the prefix matches exactly one non-empty path segment.
 */
export function matchesPathPrefix(relativePath: string, prefix: string): boolean {
  const pathSegments = relativePath.split("/");
  const prefixSegments = prefix.split("/");
  if (pathSegments.length < prefixSegments.length) return false;
  return prefixSegments.every((segment, index) =>
    segment === "*" ? pathSegments[index] !== "" : segment === pathSegments[index],
  );
}
