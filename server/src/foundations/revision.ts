import { createHash } from "node:crypto";

import { ProtocolError } from "@foundry-local-api/shared";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

export function computeRevision(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");
}

export function assertExpectedRevision(
  expected: string | undefined,
  currentValue: unknown,
): string {
  const actual = computeRevision(currentValue);
  if (expected !== undefined && expected !== actual) {
    throw new ProtocolError({
      code: "STALE_REVISION",
      message: "The target changed after it was read.",
      retryable: true,
      fieldPath: "expectedRevision",
      details: { expected, actual },
    });
  }
  return actual;
}
