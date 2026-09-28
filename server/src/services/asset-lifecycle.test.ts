import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AssetLifecycleService } from "./asset-lifecycle.js";

function png(width: number, height: number, payload = Buffer.from([0x78, 0x9c, 0x00])): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(pngCrc(Buffer.concat([header.subarray(4), data])), 0);
    return Buffer.concat([header, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", payload),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpeg(width: number, height: number): Buffer {
  const frame = Buffer.from([
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    1,
    1,
    0x11,
    0,
  ]);
  const scan = Buffer.from([1, 1, 0, 0, 63, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, frame.length + 2]),
    frame,
    Buffer.from([0xff, 0xda, 0, scan.length + 2]),
    scan,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function wav(sampleRate = 8_000, channels = 1, samples = 8): Buffer {
  const data = Buffer.alloc(samples * channels * 2);
  const result = Buffer.alloc(44 + data.length);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(channels, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * channels * 2, 28);
  result.writeUInt16LE(channels * 2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(data.length, 40);
  data.copy(result, 44);
  return result;
}

function opusOgg(granule = 48_000): Buffer {
  const payload = Buffer.alloc(19);
  payload.write("OpusHead", 0, "ascii");
  payload[8] = 1;
  payload[9] = 2;
  payload.writeUInt32LE(48_000, 12);
  const page = (body: Buffer, flags: number, sequence: number, position: number) => {
    const header = Buffer.alloc(28);
    header.write("OggS", 0, "ascii");
    header[4] = 0;
    header[5] = flags;
    header.writeBigUInt64LE(BigInt(position), 6);
    header.writeUInt32LE(7, 14);
    header.writeUInt32LE(sequence, 18);
    header[26] = 1;
    header[27] = body.length;
    const result = Buffer.concat([header, body]);
    result.writeUInt32LE(oggCrc(result), 22);
    return result;
  };
  const tags = Buffer.alloc(16);
  tags.write("OpusTags", 0, "ascii");
  const silence = Buffer.from([0xf8, 0xff, 0xfe]);
  return Buffer.concat([
    page(payload, 0x02, 0, 0),
    page(tags, 0, 1, 0),
    page(silence, 0x04, 2, granule),
  ]);
}

function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
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

void describe("asset lifecycle", () => {
  void it("hashes, moves and hash-protects deletes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asset-life-"));
    await mkdir(path.join(root, "fixtures/run1"), { recursive: true });
    await writeFile(path.join(root, "fixtures/run1/a.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const service = new AssetLifecycleService({
      roots: { data: root },
      isFixtureTestRunId: (testRunId) => testRunId === "run1",
    });
    const info = await service.inspect({ root: "data", path: "fixtures/run1/a.png" });
    assert.equal(info.decodable, false);
    await assert.rejects(
      service.move(
        {
          source: { root: "data", path: "fixtures/run1/a.png" },
          destination: { root: "data", path: "fixtures/run1/refused.png" },
          expectedHash: info.sha256!,
          collisionPolicy: "fail",
          ownership: { scope: "fixture", testRunId: "run1" },
        },
        {
          path: "fixtures/run1/a.png",
          references: [{ documentUuid: "Scene.1", fieldPath: "background.src" }],
          complete: true,
          warnings: [],
        },
      ),
      (error: unknown) => (error as { code?: string }).code === "INVALID_PAYLOAD",
    );
    await service.move(
      {
        source: { root: "data", path: "fixtures/run1/a.png" },
        destination: { root: "data", path: "fixtures/run1/b.png" },
        expectedHash: info.sha256!,
        collisionPolicy: "fail",
        ownership: { scope: "fixture", testRunId: "run1" },
      },
      { path: "fixtures/run1/a.png", references: [], complete: true, warnings: [] },
    );
    await assert.rejects(
      service.delete(
        {
          root: "data",
          path: "fixtures/run1/b.png",
          expectedHash: "bad",
          ownership: { scope: "fixture", testRunId: "run1" },
          requireUnreferenced: true,
        },
        { path: "fixtures/run1/b.png", references: [], complete: true, warnings: [] },
      ),
      (error: unknown) => (error as { code?: string }).code === "HASH_MISMATCH",
    );
  });
  void it("refuses same-file and normalized-alias moves without deleting the asset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asset-life-"));
    await mkdir(path.join(root, "fixtures/run1/dir"), { recursive: true });
    const file = path.join(root, "fixtures/run1/a.png");
    await writeFile(file, Buffer.from("same-file"));
    const service = new AssetLifecycleService({
      roots: { data: root },
      isFixtureTestRunId: (testRunId) => testRunId === "run1",
    });
    const info = await service.inspect({ root: "data", path: "fixtures/run1/a.png" });
    for (const destination of ["fixtures/run1/a.png", "fixtures/run1/dir/../a.png"]) {
      await assert.rejects(
        service.move(
          {
            source: { root: "data", path: "fixtures/run1/a.png" },
            destination: { root: "data", path: destination },
            expectedHash: info.sha256!,
            collisionPolicy: "replace-same-hash",
            ownership: { scope: "fixture", testRunId: "run1" },
          },
          { path: "fixtures/run1/a.png", references: [], complete: true, warnings: [] },
        ),
        (error: unknown) => (error as { code?: string }).code === "INVALID_PAYLOAD",
      );
      assert.equal(
        (await service.inspect({ root: "data", path: "fixtures/run1/a.png" })).exists,
        true,
      );
    }
  });
  void it("refuses traversal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asset-life-"));
    const service = new AssetLifecycleService({ roots: { data: root } });
    await assert.rejects(
      service.inspect({ root: "data", path: "../secret" }),
      (error: unknown) => (error as { code?: string }).code === "PROTECTED_PATH",
    );
  });
  void it("consults the fixture registry dynamically and rejects unknown runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asset-life-"));
    let registered = false;
    const service = new AssetLifecycleService({
      roots: { data: root },
      isFixtureTestRunId: () => registered,
    });
    await assert.rejects(
      service.delete(
        {
          root: "data",
          path: "fixtures/run2/a.png",
          expectedHash: "a".repeat(64),
          ownership: { scope: "fixture", testRunId: "run2" },
          requireUnreferenced: true,
        },
        { path: "fixtures/run2/a.png", references: [], complete: true, warnings: [] },
      ),
      (error: unknown) => (error as { code?: string }).code === "PERMISSION_DENIED",
    );
    registered = true;
    const result = await service.delete(
      {
        root: "data",
        path: "fixtures/run2/a.png",
        expectedHash: "a".repeat(64),
        ownership: { scope: "fixture", testRunId: "run2" },
        requireUnreferenced: true,
      },
      { path: "fixtures/run2/a.png", references: [], complete: true, warnings: [] },
    );
    assert.equal(result.alreadyAbsent, true);
  });
  void it("streams hashing for a multi-megabyte file and reads only a bounded signature header", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asset-life-"));
    const target = path.join(root, "large.bin");
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0x5a);
    await writeFile(target, bytes);
    const service = new AssetLifecycleService({ roots: { data: root } });
    const result = await service.inspect({ root: "data", path: "large.bin" });
    assert.equal(result.size, bytes.length);
    assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  });
  void it("validates supported PNG, JPEG, WAV, and OGG structures with safe metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asset-life-"));
    await writeFile(path.join(root, "valid.png"), png(3, 2));
    await writeFile(path.join(root, "valid.jpg"), jpeg(7, 5));
    await writeFile(path.join(root, "valid.wav"), wav());
    await writeFile(path.join(root, "valid.ogg"), opusOgg());
    const service = new AssetLifecycleService({ roots: { data: root } });
    const pngInfo = await service.inspect({ root: "data", path: "valid.png" });
    const jpegInfo = await service.inspect({ root: "data", path: "valid.jpg" });
    const wavInfo = await service.inspect({ root: "data", path: "valid.wav" });
    const oggInfo = await service.inspect({ root: "data", path: "valid.ogg" });
    assert.deepEqual(pngInfo.metadata, {
      format: "png",
      codec: "deflate",
      width: 3,
      height: 2,
    });
    assert.equal(pngInfo.decodable, false);
    assert.equal(pngInfo.structurallyValid, true);
    assert.deepEqual(jpegInfo.metadata, {
      format: "jpeg",
      codec: "jpeg",
      width: 7,
      height: 5,
    });
    assert.equal(jpegInfo.decodable, false);
    assert.equal(jpegInfo.structurallyValid, true);
    assert.equal(wavInfo.metadata?.codec, "pcm");
    assert.equal(wavInfo.metadata?.sampleRate, 8_000);
    assert.equal(wavInfo.metadata?.durationSeconds, 0.001);
    assert.equal(wavInfo.decodable, false);
    assert.equal(wavInfo.structurallyValid, true);
    assert.equal(oggInfo.metadata?.codec, "opus");
    assert.equal(oggInfo.metadata?.channels, 2);
    assert.equal(oggInfo.metadata?.durationSeconds, 1);
    assert.equal(oggInfo.decodable, false);
    assert.equal(oggInfo.structurallyValid, true);
    assert.equal(typeof pngInfo.modifiedTimeMs, "number");
  });
  void it("fails closed for malformed and truncated recognized media", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asset-life-"));
    const malformedPng = png(0, 2);
    const malformedJpeg = jpeg(7, 5).subarray(0, -2);
    const malformedWav = wav();
    malformedWav.writeUInt32LE(1, 4);
    const malformedOgg = opusOgg();
    malformedOgg[5] = 0x02;
    const fixtures: Array<[string, Buffer]> = [
      ["malformed.png", malformedPng],
      ["truncated.jpg", malformedJpeg],
      ["malformed.wav", malformedWav],
      ["truncated.ogg", malformedOgg.subarray(0, -1)],
    ];
    for (const [name, bytes] of fixtures) await writeFile(path.join(root, name), bytes);
    const service = new AssetLifecycleService({ roots: { data: root } });
    for (const [name] of fixtures) {
      const result = await service.inspect({ root: "data", path: name });
      assert.equal(result.decodable, false, name);
      assert.equal(result.metadata, undefined, name);
      assert.match(result.mediaType ?? "", /^(image|audio)\//, name);
    }
  });
  void it("parses a large supported file without an unbounded media read", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asset-life-"));
    const bytes = png(1920, 1080, Buffer.alloc(4 * 1024 * 1024, 0x5a));
    await writeFile(path.join(root, "large.png"), bytes);
    const reads: number[] = [];
    const service = new AssetLifecycleService({
      roots: { data: root },
      observeMediaRead: (requestedBytes) => reads.push(requestedBytes),
    });
    const result = await service.inspect({ root: "data", path: "large.png" });
    assert.equal(result.decodable, false);
    assert.equal(result.structurallyValid, true);
    assert.equal(result.metadata?.width, 1920);
    assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.ok(reads.length > 0);
    assert.ok(Math.max(...reads) <= 64 * 1024);
    assert.ok(reads.every((length) => length < bytes.length));
  });
  void it("fails closed on incomplete reference scans before move or delete", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asset-life-"));
    await mkdir(path.join(root, "fixtures/run3"), { recursive: true });
    const file = path.join(root, "fixtures/run3/a.png");
    await writeFile(file, "unchanged");
    const service = new AssetLifecycleService({
      roots: { data: root },
      isFixtureTestRunId: (testRunId) => testRunId === "run3",
    });
    const info = await service.inspect({ root: "data", path: "fixtures/run3/a.png" });
    const incomplete = {
      path: "fixtures/run3/a.png",
      references: [],
      complete: false,
      warnings: ["bounded"],
    };
    await assert.rejects(
      service.move(
        {
          source: { root: "data", path: "fixtures/run3/a.png" },
          destination: { root: "data", path: "fixtures/run3/b.png" },
          expectedHash: info.sha256!,
          collisionPolicy: "fail",
          ownership: { scope: "fixture", testRunId: "run3" },
        },
        incomplete,
      ),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
    await assert.rejects(
      service.move(
        {
          source: { root: "data", path: "fixtures/run3/a.png" },
          destination: { root: "data", path: "fixtures/run3/b.png" },
          expectedHash: info.sha256!,
          collisionPolicy: "fail",
          ownership: { scope: "fixture", testRunId: "run3" },
        },
        { ...incomplete, path: "fixtures/run3/other.png", complete: true },
      ),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
    await assert.rejects(
      service.delete(
        {
          root: "data",
          path: "fixtures/run3/a.png",
          expectedHash: info.sha256!,
          ownership: { scope: "fixture", testRunId: "run3" },
          requireUnreferenced: true,
        },
        incomplete,
      ),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
    assert.equal(await readFile(file, "utf8"), "unchanged");
  });
  void it("replays move and delete without repeating mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asset-life-"));
    await mkdir(path.join(root, "fixtures/run4"), { recursive: true });
    await writeFile(path.join(root, "fixtures/run4/a.png"), "replay");
    const service = new AssetLifecycleService({
      roots: { data: root },
      isFixtureTestRunId: (testRunId) => testRunId === "run4",
    });
    const source = { root: "data", path: "fixtures/run4/a.png" };
    const destination = { root: "data", path: "fixtures/run4/b.png" };
    const info = await service.inspect(source);
    const move = {
      source,
      destination,
      expectedHash: info.sha256!,
      collisionPolicy: "fail" as const,
      ownership: { scope: "fixture" as const, testRunId: "run4" },
    };
    const references = { path: source.path, references: [], complete: true, warnings: [] };
    assert.equal((await service.move(move, references)).alreadyAbsent, false);
    assert.equal((await service.move(move, references)).alreadyAbsent, true);
    const deletion = {
      ...destination,
      expectedHash: info.sha256!,
      ownership: move.ownership,
      requireUnreferenced: true as const,
    };
    const deleteReferences = {
      path: destination.path,
      references: [],
      complete: true,
      warnings: [],
    };
    assert.equal((await service.delete(deletion, deleteReferences)).alreadyAbsent, false);
    assert.equal((await service.delete(deletion, deleteReferences)).alreadyAbsent, true);
  });
  void it("rejects symlinked source and destination ancestors", async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "asset-life-"));
    const outside = await mkdtemp(path.join(tmpdir(), "asset-outside-"));
    await writeFile(path.join(outside, "secret.png"), "secret");
    try {
      await symlink(outside, path.join(root, "linked"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("Host does not permit creating a test junction");
        return;
      }
      throw error;
    }
    const service = new AssetLifecycleService({ roots: { data: root } });
    await assert.rejects(
      service.inspect({ root: "data", path: "linked/secret.png" }),
      (error: unknown) => (error as { code?: string }).code === "PROTECTED_PATH",
    );
  });
  void it("normalizes ownership paths before checking exact fixture namespace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asset-life-"));
    const service = new AssetLifecycleService({
      roots: { data: root },
      isFixtureTestRunId: () => true,
    });
    await assert.rejects(
      service.delete(
        {
          root: "data",
          path: "fixtures/run5/../another-run/a.png",
          expectedHash: "a".repeat(64),
          ownership: { scope: "fixture", testRunId: "run5" },
          requireUnreferenced: true,
        },
        {
          path: "fixtures/another-run/a.png",
          references: [],
          complete: true,
          warnings: [],
        },
      ),
      (error: unknown) => (error as { code?: string }).code === "PERMISSION_DENIED",
    );
  });
});
