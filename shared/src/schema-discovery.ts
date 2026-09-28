/** Typed, read-only schema discovery and validation contract (MCP-REQ-003). */
export const SCHEMA_DISCOVERY_COMMANDS = {
  DISCOVER: "schemaDiscover",
  VALIDATE: "schemaValidate",
} as const;

export type SchemaValidationMode = "create" | "update";

export interface SchemaTargetInput {
  /** Foundry document name, including embedded names such as Token or TableResult. */
  documentType: string;
  /** Optional parent constraint for an embedded document. */
  parentDocumentType?: string | undefined;
  /** Optional parent reference, checked without returning parent data. */
  parentDocumentId?: string | undefined;
  /** System subtype, for example Actor `character` or Item `weapon`. */
  subtype?: string | undefined;
  /** Exact runtime lock: callers must opt in to the versions they validated against. */
  expectedFoundryVersion: string;
  expectedSystemId: string;
  expectedSystemVersion: string;
}

export interface SchemaValidationInput extends SchemaTargetInput {
  mode: SchemaValidationMode;
  /** Compatibility single-candidate form. Exactly one of data/candidates is required. */
  data?: Record<string, unknown> | undefined;
  /** Preferred batch form. Every candidate is validated independently. */
  candidates?: Record<string, unknown>[] | undefined;
}

export interface SchemaRuntimeContext {
  foundryVersion: string;
  systemId: string;
  systemVersion: string;
  moduleVersion: string;
  documentType: string;
  parentDocumentType?: string | undefined;
  parentDocumentId?: string | undefined;
  embedded: boolean;
  subtype?: string | undefined;
  /** The system DataModel name used to expand `system.*`, when one was available. */
  systemModel?: string | undefined;
}

export interface DiscoveredSchemaField {
  /** Dot path in the candidate source object. */
  path: string;
  type: string;
  required: boolean;
  nullable: boolean;
  hasDefault: boolean;
  /** Present only for JSON-safe, non-function defaults. */
  defaultValue?: unknown;
  dynamicDefault?: boolean | undefined;
  dynamicChoices?: boolean | undefined;
  choices?: Array<string | number | boolean> | undefined;
}

export interface SchemaDiscoveryResult {
  context: SchemaRuntimeContext;
  fields: DiscoveredSchemaField[];
  limitations: string[];
  readOnly: true;
}

export interface SchemaValidationIssue {
  severity: "error" | "warning";
  code: "REQUIRED" | "INVALID_TYPE" | "INVALID_ENUM" | "UNKNOWN_FIELD" | "NATIVE_VALIDATION";
  path: string;
  message: string;
}

export interface SchemaValidationResult {
  index: number;
  context: SchemaRuntimeContext;
  mode: SchemaValidationMode;
  valid: boolean;
  normalized: Record<string, unknown>;
  errors: SchemaValidationIssue[];
  warnings: SchemaValidationIssue[];
  /** Always true unless a future implementation introduces a mutating validator. */
  inputUnchanged: boolean;
  /** Explicit proof marker: schema validation never calls Document create/update/delete. */
  persisted: false;
  migrationWarnings: string[];
  /** Explicitly records validation stages that could not safely run. */
  limitations: string[];
}

export interface SchemaValidationBatchResult {
  context: SchemaRuntimeContext;
  mode: SchemaValidationMode;
  results: SchemaValidationResult[];
  validCount: number;
  invalidCount: number;
  complete: true;
  persisted: false;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A deterministic JSON-safe clone used before any Foundry cleaner/validator is called. */
export function cloneSchemaCandidate(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
}

export function stableSchemaValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSchemaValue).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSchemaValue(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function valueAtPath(data: Record<string, unknown>, path: string): unknown {
  let current: unknown = data;
  for (const part of path.split(".")) {
    if (!isPlainRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function isCompatibleType(value: unknown, fieldType: string): boolean {
  const name = fieldType.toLowerCase();
  if (name.includes("string")) return typeof value === "string";
  if (name.includes("number")) return typeof value === "number" && Number.isFinite(value);
  if (name.includes("boolean")) return typeof value === "boolean";
  if (name.includes("array")) return Array.isArray(value);
  if (name.includes("object") || name.includes("schema")) return isPlainRecord(value);
  return true;
}

/** Portable checks supplement Foundry's native DataField validator with stable field paths. */
export function validateDiscoveredFields(
  data: Record<string, unknown>,
  fields: DiscoveredSchemaField[],
  mode: SchemaValidationMode,
): { errors: SchemaValidationIssue[]; warnings: SchemaValidationIssue[] } {
  const errors: SchemaValidationIssue[] = [];
  const warnings: SchemaValidationIssue[] = [];
  const known = new Set(fields.map((field) => field.path));
  const parents = new Set<string>();
  for (const path of known) {
    const parts = path.split(".");
    while (parts.length > 1) {
      parts.pop();
      parents.add(parts.join("."));
    }
  }

  for (const field of fields) {
    const value = valueAtPath(data, field.path);
    if (mode === "create" && field.required && value === undefined && !field.hasDefault) {
      errors.push({
        severity: "error",
        code: "REQUIRED",
        path: field.path,
        message: `Required field "${field.path}" is missing.`,
      });
      continue;
    }
    if (value === undefined) continue;
    if (value === null) {
      if (!field.nullable) {
        errors.push({
          severity: "error",
          code: "INVALID_TYPE",
          path: field.path,
          message: `Field "${field.path}" does not allow null.`,
        });
      }
      continue;
    }
    if (!isCompatibleType(value, field.type)) {
      errors.push({
        severity: "error",
        code: "INVALID_TYPE",
        path: field.path,
        message: `Field "${field.path}" is not a valid ${field.type}.`,
      });
    }
    if (field.choices && !field.choices.some((choice) => Object.is(choice, value))) {
      errors.push({
        severity: "error",
        code: "INVALID_ENUM",
        path: field.path,
        message: `Field "${field.path}" is not one of the allowed values.`,
      });
    }
  }

  function visit(value: unknown, prefix = ""): void {
    if (!isPlainRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!known.has(path) && !parents.has(path)) {
        warnings.push({
          severity: "warning",
          code: "UNKNOWN_FIELD",
          path,
          message: `Field "${path}" is not present in the discovered schema.`,
        });
        continue;
      }
      visit(child, path);
    }
  }
  visit(data);
  return { errors, warnings };
}
