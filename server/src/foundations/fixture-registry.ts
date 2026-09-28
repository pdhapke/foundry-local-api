import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  ProtocolError,
  type TestFixtureDocumentRef,
  type TestFixtureRun,
} from "@foundry-local-api/shared";

export class FixtureRegistry {
  private readonly runs = new Map<string, TestFixtureRun>();

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    try {
      let contents: string;
      try {
        contents = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const temporary = `${path}.tmp`;
        contents = readFileSync(temporary, "utf8");
        // An interrupted atomic replacement left the complete temporary snapshot behind.
        renameSync(temporary, path);
      }
      const parsed = JSON.parse(contents) as TestFixtureRun[];
      for (const run of parsed) this.runs.set(run.testRunId, run);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  create(testRunId: string): TestFixtureRun {
    if (!/^test-[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/.test(testRunId)) {
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: "testRunId must be a namespaced test-* identifier of 13-84 characters.",
        retryable: false,
        fieldPath: "testRunId",
      });
    }
    const existing = this.runs.get(testRunId);
    if (existing) return structuredClone(existing);
    const run: TestFixtureRun = {
      testRunId,
      namespace: "foundry-local-api",
      createdAt: new Date().toISOString(),
      documents: [],
      files: [],
    };
    this.runs.set(testRunId, run);
    this.persist();
    return structuredClone(run);
  }

  get(testRunId: string): TestFixtureRun {
    const run = this.runs.get(testRunId);
    if (!run) {
      throw new ProtocolError({
        code: "NOT_FOUND",
        message: `Fixture run "${testRunId}" is not recorded.`,
        retryable: false,
        fieldPath: "testRunId",
      });
    }
    return structuredClone(run);
  }

  has(testRunId: string): boolean {
    return this.runs.has(testRunId);
  }

  recordDocument(testRunId: string, ref: TestFixtureDocumentRef): TestFixtureRun {
    const run = this.get(testRunId);
    if (!run.documents.some((item) => JSON.stringify(item) === JSON.stringify(ref))) {
      run.documents.push(ref);
      this.runs.set(testRunId, run);
      this.persist();
    }
    return structuredClone(run);
  }

  recordFile(
    testRunId: string,
    file: { root: string; path: string; sha256: string },
  ): TestFixtureRun {
    const run = this.get(testRunId);
    if (!run.files.some((item) => item.root === file.root && item.path === file.path)) {
      run.files.push(file);
      this.runs.set(testRunId, run);
      this.persist();
    }
    return structuredClone(run);
  }

  moveFile(
    testRunId: string,
    source: { root: string; path: string },
    target: { root: string; path: string; sha256: string },
  ): TestFixtureRun {
    const run = this.get(testRunId);
    const index = run.files.findIndex(
      (item) => item.root === source.root && item.path === source.path,
    );
    if (index < 0)
      throw new ProtocolError({
        code: "NOT_FOUND",
        message: "The fixture asset is not recorded in the exact cleanup manifest.",
        retryable: false,
        fieldPath: "source.path",
      });
    run.files[index] = target;
    this.runs.set(testRunId, run);
    this.persist();
    return structuredClone(run);
  }

  removeFile(testRunId: string, target: { root: string; path: string }): TestFixtureRun {
    const run = this.get(testRunId);
    run.files = run.files.filter(
      (item) => !(item.root === target.root && item.path === target.path),
    );
    this.runs.set(testRunId, run);
    this.persist();
    return structuredClone(run);
  }

  /** Returns only exact recorded IDs; callers cannot supply a path, query, or wildcard. */
  cleanupPlan(testRunId: string): TestFixtureRun {
    return this.get(testRunId);
  }

  private persist(): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.runs.values()], null, 2), "utf8");
    renameSync(temporary, this.path);
  }
}
