import type { TestFixtureDocumentRef } from "./foundations.js";

export const TRACK0_COMMANDS = {
  CAPABILITY_REPORT: "track0CapabilityReport",
  FIXTURE_CREATE: "track0FixtureCreate",
  FIXTURE_GET: "track0FixtureGet",
  FIXTURE_RECORD_DOCUMENT: "track0FixtureRecordDocument",
  FIXTURE_CLEANUP_PLAN: "track0FixtureCleanupPlan",
} as const;

export interface TestRunIdInput {
  testRunId: string;
}

export interface RecordFixtureDocumentInput extends TestRunIdInput {
  document: TestFixtureDocumentRef;
}

/** Adds the only accepted fixture ownership flag without replacing other flags. */
export function withTestRunFlag(
  data: Record<string, unknown>,
  testRunId: string,
): Record<string, unknown> {
  const flags = (data["flags"] as Record<string, unknown> | undefined) ?? {};
  const moduleFlags = (flags["foundry-local-api"] as Record<string, unknown> | undefined) ?? {};
  return {
    ...data,
    flags: {
      ...flags,
      "foundry-local-api": { ...moduleFlags, testRunId },
    },
  };
}
