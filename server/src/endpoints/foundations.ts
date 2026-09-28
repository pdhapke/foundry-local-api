import { z } from "zod";

import type {
  CapabilityReport,
  RecordFixtureFileInput,
  RecordFixtureDocumentInput,
  TestFixtureRun,
  TestRunIdInput,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor } from "./types.js";
import type { FoundationRuntime } from "../foundations/runtime.js";

const testRunId = z
  .string()
  .min(13)
  .max(84)
  .regex(/^test-[A-Za-z0-9][A-Za-z0-9._-]+$/);
const testRunSchema = z.object({ testRunId });
const documentRefSchema = z.object({
  documentType: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
  parentType: z.string().min(1).max(64).optional(),
  parentId: z.string().min(1).max(128).optional(),
});
const fileRefSchema = z
  .object({
    root: z.string().min(1).max(64),
    path: z.string().min(1).max(1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

function requireFoundations(ctx: { foundations?: FoundationRuntime | undefined }) {
  if (!ctx.foundations) throw new Error("Track 0 foundation runtime is not configured.");
  return ctx.foundations;
}

export const foundationEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_get_capability_report",
    description:
      "Reports negotiated bridge/server/client versions and classifies foundational capabilities as supported, partial, or unsupported, with connected and live-verified state.",
    method: "get",
    path: "/capabilities",
    handler: (_input: void, { foundryClient }): CapabilityReport =>
      foundryClient.getCapabilityReport(),
    annotations: { readOnlyHint: true },
  },
  {
    name: "foundry_create_test_fixture_run",
    description:
      "Creates or reads a namespaced non-canonical test-run manifest. Test documents must carry flags.foundry-local-api.testRunId.",
    method: "post",
    path: "/fixtures/runs",
    inputSchema: testRunSchema,
    handler: (input: TestRunIdInput, ctx): TestFixtureRun =>
      requireFoundations(ctx).fixtures.create(input.testRunId),
  },
  {
    name: "foundry_get_test_fixture_run",
    description: "Reads one exact test-run manifest; never searches or expands a wildcard.",
    method: "get",
    path: "/fixtures/runs/:testRunId",
    inputSchema: testRunSchema,
    handler: (input: TestRunIdInput, ctx): TestFixtureRun =>
      requireFoundations(ctx).fixtures.get(input.testRunId),
    annotations: { readOnlyHint: true },
  },
  {
    name: "foundry_record_test_fixture_document",
    description: "Records one exact created fixture document ID for later exact-ID cleanup.",
    method: "post",
    path: "/fixtures/runs/:testRunId/documents",
    inputSchema: z.object({ testRunId, document: documentRefSchema }),
    handler: (input: RecordFixtureDocumentInput, ctx): TestFixtureRun =>
      requireFoundations(ctx).fixtures.recordDocument(input.testRunId, input.document),
  },
  {
    name: "foundry_get_test_fixture_cleanup_plan",
    description:
      "Returns only the exact document and file IDs previously recorded for a test run. It performs no broad deletion.",
    method: "get",
    path: "/fixtures/runs/:testRunId/cleanup-plan",
    inputSchema: testRunSchema,
    handler: (input: TestRunIdInput, ctx): TestFixtureRun =>
      requireFoundations(ctx).fixtures.cleanupPlan(input.testRunId),
    annotations: { readOnlyHint: true },
  },
  {
    name: "foundry_record_test_fixture_file",
    description:
      "Records one exact fixture asset root/path/hash for exact cleanup and lifecycle checks.",
    method: "post",
    path: "/fixtures/runs/:testRunId/files",
    inputSchema: z.object({ testRunId, file: fileRefSchema }).strict(),
    handler: (input: RecordFixtureFileInput, ctx): TestFixtureRun =>
      requireFoundations(ctx).fixtures.recordFile(input.testRunId, input.file),
  },
];
