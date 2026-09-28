import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { MutationAuditRecord } from "@foundry-local-api/shared";

const SENSITIVE_KEY = /api.?key|authorization|cookie|password|secret|session|token|credential/i;
const SAFE_SCALAR_KEY = /(^|_)(id|type|mode|operation|documentType|parentType|sceneId|userId)$/i;

export function summarizeAuditPayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return { type: typeof value };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  const input = value as Record<string, unknown>;
  const summary: Record<string, unknown> = { keys: Object.keys(input).sort() };
  for (const [key, child] of Object.entries(input)) {
    if (SENSITIVE_KEY.test(key)) {
      summary[key] = "[REDACTED]";
    } else if (
      SAFE_SCALAR_KEY.test(key) &&
      ["string", "number", "boolean"].includes(typeof child)
    ) {
      summary[key] = child;
    }
  }
  return summary;
}

/** Append-only JSONL audit sink. The file path is server-local and never returned by an API. */
export class DurableAuditLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(record: MutationAuditRecord): void {
    const safe: MutationAuditRecord = {
      ...record,
      ...(record.payloadSummary === undefined
        ? {}
        : { payloadSummary: summarizeAuditPayload(record.payloadSummary) }),
    };
    appendFileSync(this.path, `${JSON.stringify(safe)}\n`, { encoding: "utf8", flag: "a" });
  }
}
