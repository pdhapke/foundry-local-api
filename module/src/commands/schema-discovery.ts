import {
  ProtocolError,
  SCHEMA_DISCOVERY_COMMANDS,
  cloneSchemaCandidate,
  stableSchemaValue,
  validateDiscoveredFields,
  type DiscoveredSchemaField,
  type SchemaDiscoveryResult,
  type SchemaRuntimeContext,
  type SchemaTargetInput,
  type SchemaValidationInput,
  type SchemaValidationBatchResult,
  type SchemaValidationIssue,
  type SchemaValidationResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

interface RuntimeDataField {
  options?: {
    required?: boolean;
    nullable?: boolean;
    initial?: unknown;
    choices?: unknown;
  };
  required?: boolean;
  nullable?: boolean;
  initial?: unknown;
  choices?: unknown;
  fields?: unknown;
  element?: RuntimeDataField;
  constructor?: { name?: string };
  clean?: (value: unknown, options?: Record<string, unknown>) => unknown;
  validate?: (value: unknown, options?: Record<string, unknown>) => unknown;
}

interface RuntimeSchema {
  fields?: unknown;
  _validateModel?: (data: Record<string, unknown>) => unknown;
}

interface RuntimeModelInstance {
  validate?: (options?: Record<string, unknown>) => unknown;
  updateSource?: (changes: Record<string, unknown>, options?: Record<string, unknown>) => unknown;
  toObject?: () => Record<string, unknown>;
}

interface RuntimeModelStatics {
  name?: string;
  schema?: RuntimeSchema | Record<string, RuntimeDataField>;
  cleanData?: (
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Record<string, unknown>;
  migrateDataSafe?: (data: Record<string, unknown>) => Record<string, unknown>;
  validateJoint?: (data: Record<string, unknown>) => unknown;
  metadata?: { embedded?: Record<string, string> | Map<string, string>; isEmbedded?: boolean };
}

type RuntimeModelClass = RuntimeModelStatics &
  (new (data?: Record<string, unknown>, options?: Record<string, unknown>) => RuntimeModelInstance);

interface RuntimeConfigEntry {
  documentClass?: RuntimeModelClass;
  dataModels?: Record<string, RuntimeModelClass> | Map<string, RuntimeModelClass>;
}

function runtimeConfig(): Record<string, RuntimeConfigEntry | undefined> {
  return CONFIG as unknown as Record<string, RuntimeConfigEntry | undefined>;
}

function ownEntries(value: unknown): Array<[string, RuntimeDataField]> {
  if (value instanceof Map) return [...value.entries()] as Array<[string, RuntimeDataField]>;
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, RuntimeDataField>);
  }
  return [];
}

function schemaFields(model: RuntimeModelClass): Array<[string, RuntimeDataField]> {
  const schema = model.schema;
  if (!schema) return [];
  if ("fields" in schema && schema.fields) return ownEntries(schema.fields);
  return ownEntries(schema);
}

function enumChoices(value: unknown): Array<string | number | boolean> | undefined {
  let raw: unknown[];
  if (Array.isArray(value)) raw = value;
  else if (value instanceof Set) raw = [...value];
  else if (value instanceof Map) raw = [...value.keys()];
  else if (value && typeof value === "object") raw = Object.keys(value as object);
  else return undefined;
  const choices = raw.filter(
    (choice): choice is string | number | boolean =>
      typeof choice === "string" || typeof choice === "number" || typeof choice === "boolean",
  );
  return choices.length > 0 ? choices : undefined;
}

function jsonSafeDefault(value: unknown): unknown | undefined {
  if (typeof value === "function" || value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}

function inspectFields(
  entries: Array<[string, RuntimeDataField]>,
  prefix = "",
): DiscoveredSchemaField[] {
  const result: DiscoveredSchemaField[] = [];
  for (const [name, field] of entries) {
    const path = prefix ? `${prefix}.${name}` : name;
    const nested = ownEntries(field.fields);
    const type = field.constructor?.name || "DataField";
    const hasOption = (key: string) =>
      Boolean(field.options && Object.prototype.hasOwnProperty.call(field.options, key));
    const required = hasOption("required") ? field.options?.required : (field.required ?? false);
    const nullable = hasOption("nullable") ? field.options?.nullable : (field.nullable ?? false);
    const configuredInitial = hasOption("initial") ? field.options?.initial : field.initial;
    const configuredChoices = hasOption("choices") ? field.options?.choices : field.choices;
    const initial = jsonSafeDefault(configuredInitial);
    const descriptor: DiscoveredSchemaField = {
      path,
      type,
      required: required === true,
      nullable: nullable === true,
      hasDefault: configuredInitial !== undefined,
      ...(initial !== undefined ? { defaultValue: initial } : {}),
      ...(typeof configuredInitial === "function" ? { dynamicDefault: true } : {}),
      ...(typeof configuredChoices === "function" ? { dynamicChoices: true } : {}),
      ...(enumChoices(configuredChoices) ? { choices: enumChoices(configuredChoices) } : {}),
    };
    result.push(descriptor);
    if (nested.length > 0) result.push(...inspectFields(nested, path));
  }
  return result;
}

function getDataModel(
  entry: RuntimeConfigEntry,
  subtype: string | undefined,
  documentType: string,
): RuntimeModelClass | undefined {
  if (!subtype) return undefined;
  const models = entry.dataModels;
  const model = models instanceof Map ? models.get(subtype) : models?.[subtype];
  if (!model) {
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message: `${documentType} subtype "${subtype}" is not registered by the active system.`,
      retryable: false,
      fieldPath: "subtype",
      details: { documentType, subtype },
    });
  }
  return model;
}

function embeddedNames(model: RuntimeModelClass): Set<string> {
  const embedded = model.metadata?.embedded;
  if (embedded instanceof Map) return new Set(embedded.keys());
  return new Set(Object.keys(embedded ?? {}));
}

interface RuntimeDocumentReference extends FoundryDocument {
  testUserPermission?: (user: FoundryUser, permission: string) => boolean;
  getEmbeddedCollection?: (documentType: string) => Map<string, RuntimeDocumentReference>;
}

function resolveVisibleParent(documentType: string, id: string): void {
  const matches: Array<{
    document: RuntimeDocumentReference;
    permissionHost: RuntimeDocumentReference;
  }> = [];
  const seen = new Set<RuntimeDocumentReference>();
  const record = (
    document: RuntimeDocumentReference | undefined,
    host: RuntimeDocumentReference,
  ) => {
    if (!document || seen.has(document)) return;
    seen.add(document);
    matches.push({ document, permissionHost: host });
  };

  const world = game.collections.get(documentType);
  const worldDocument = world?.get(id) as RuntimeDocumentReference | undefined;
  if (worldDocument) record(worldDocument, worldDocument);

  // Region, Item, and other embedded parent IDs are scoped by their owning world
  // document. Search exact embedded collections without returning any source data.
  for (const [ownerType, collection] of game.collections.entries()) {
    const ownerModel = runtimeConfig()[ownerType]?.documentClass;
    if (!ownerModel || !embeddedNames(ownerModel).has(documentType)) continue;
    for (const candidate of collection.values() as Iterable<RuntimeDocumentReference>) {
      try {
        const embedded = candidate.getEmbeddedCollection?.(documentType).get(id);
        if (embedded) record(embedded, candidate);
      } catch {
        // Foundry throws for an unknown/unavailable embedded collection on some
        // document implementations. One unrelated owner must not abort lookup.
        continue;
      }
    }
  }

  const visibleMatches = matches.filter(
    (match) =>
      game.user.isGM ||
      match.document.testUserPermission?.(game.user, "OBSERVER") === true ||
      match.permissionHost.testUserPermission?.(game.user, "OBSERVER") === true,
  );
  if (visibleMatches.length > 1) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "parentDocumentId is ambiguous across embedded parent contexts.",
      retryable: false,
      fieldPath: "parentDocumentId",
    });
  }
  if (visibleMatches.length === 0) {
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: "The requested parent document is unavailable to the executing user.",
      retryable: false,
      fieldPath: "parentDocumentId",
    });
  }
}

function resolveTarget(input: SchemaTargetInput): {
  context: SchemaRuntimeContext;
  documentModel: RuntimeModelClass;
  systemModel?: RuntimeModelClass | undefined;
  fields: DiscoveredSchemaField[];
  limitations: string[];
} {
  const foundryVersion = game.release.version;
  if (!/^14(?:\.|$)/.test(foundryVersion)) {
    throw new ProtocolError({
      code: "UNSUPPORTED_VERSION",
      message: `Schema discovery is verified for Foundry 14; connected client reports ${foundryVersion}.`,
      retryable: false,
      fieldPath: "foundryVersion",
      details: { supportedMajor: 14, actual: foundryVersion },
    });
  }
  const expectedVersions: Array<[string, string, string]> = [
    ["expectedFoundryVersion", input.expectedFoundryVersion, foundryVersion],
    ["expectedSystemId", input.expectedSystemId, game.system.id],
    ["expectedSystemVersion", input.expectedSystemVersion, game.system.version],
  ];
  for (const [fieldPath, expected, actual] of expectedVersions) {
    if (expected !== actual) {
      throw new ProtocolError({
        code: "UNSUPPORTED_VERSION",
        message: `Runtime context mismatch for ${fieldPath}.`,
        retryable: false,
        fieldPath,
        details: { expected, actual },
      });
    }
  }
  const entry = runtimeConfig()[input.documentType];
  const documentModel = entry?.documentClass;
  if (!entry || !documentModel) {
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message: `Document type "${input.documentType}" is not available on this client.`,
      retryable: false,
      fieldPath: "documentType",
      details: { documentType: input.documentType },
    });
  }

  if (input.parentDocumentType) {
    const parent = runtimeConfig()[input.parentDocumentType]?.documentClass;
    if (!parent) {
      throw new ProtocolError({
        code: "UNSUPPORTED_TYPE",
        message: `Parent document type "${input.parentDocumentType}" is not available.`,
        retryable: false,
        fieldPath: "parentDocumentType",
      });
    }
    if (!embeddedNames(parent).has(input.documentType)) {
      throw new ProtocolError({
        code: "UNSUPPORTED_TYPE",
        message: `${input.documentType} is not an embedded child of ${input.parentDocumentType}.`,
        retryable: false,
        fieldPath: "parentDocumentType",
        details: { documentType: input.documentType, parentDocumentType: input.parentDocumentType },
      });
    }
    if (input.parentDocumentId) {
      resolveVisibleParent(input.parentDocumentType, input.parentDocumentId);
    }
  } else if (input.parentDocumentId) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "parentDocumentId requires parentDocumentType.",
      retryable: false,
      fieldPath: "parentDocumentId",
    });
  }

  const systemModel = getDataModel(entry, input.subtype, input.documentType);
  const coreFields = inspectFields(schemaFields(documentModel));
  const systemFields = systemModel ? inspectFields(schemaFields(systemModel), "system") : [];
  const fields = [
    ...coreFields.filter((field) => !systemModel || !field.path.startsWith("system.")),
    ...systemFields,
  ].sort((left, right) => left.path.localeCompare(right.path));
  const limitations: string[] = [];
  if (fields.length === 0)
    limitations.push("The selected Foundry DataModel exposed no inspectable fields.");
  if (entry.dataModels && !input.subtype) {
    limitations.push("Subtype-specific system fields require a subtype parameter.");
  }
  if (fields.some((field) => field.dynamicDefault)) {
    limitations.push("Dynamic defaults are identified but not executed during discovery.");
  }
  if (fields.some((field) => field.dynamicChoices)) {
    limitations.push("Dynamic choice providers are identified but not executed during discovery.");
  }
  const moduleVersion = game.modules.get("foundry-local-api")?.version ?? "unknown";
  const context: SchemaRuntimeContext = {
    foundryVersion,
    systemId: game.system.id,
    systemVersion: game.system.version,
    moduleVersion,
    documentType: input.documentType,
    ...(input.parentDocumentType ? { parentDocumentType: input.parentDocumentType } : {}),
    ...(input.parentDocumentId ? { parentDocumentId: input.parentDocumentId } : {}),
    embedded: Boolean(input.parentDocumentType || documentModel.metadata?.isEmbedded),
    ...(input.subtype ? { subtype: input.subtype } : {}),
    ...(systemModel
      ? { systemModel: systemModel.name ?? `${input.documentType}.${input.subtype}` }
      : {}),
  };
  return { context, documentModel, systemModel, fields, limitations };
}

function applyPortableDefaults(
  normalized: Record<string, unknown>,
  fields: DiscoveredSchemaField[],
): void {
  for (const field of fields) {
    if (!field.hasDefault || field.dynamicDefault || field.defaultValue === undefined) continue;
    const parts = field.path.split(".");
    let target = normalized;
    for (const part of parts.slice(0, -1)) {
      const child = target[part];
      if (!child || typeof child !== "object" || Array.isArray(child)) target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    const key = parts.at(-1)!;
    if (!(key in target)) target[key] = cloneSchemaCandidate({ value: field.defaultValue }).value;
  }
}

function cleanWithModel(
  model: RuntimeModelClass,
  data: Record<string, unknown>,
  partial: boolean,
): Record<string, unknown> {
  if (!model.cleanData) return data;
  return model.cleanData(data, {
    copy: true,
    migrate: false,
    model: true,
    prune: true,
    persisted: true,
    sanitize: false,
    partial,
  });
}

function nativeValidationIssue(error: unknown): SchemaValidationIssue {
  const candidate = error as { path?: unknown; message?: unknown };
  return {
    severity: "error",
    code: "NATIVE_VALIDATION",
    path: typeof candidate?.path === "string" ? candidate.path : "$",
    message:
      typeof candidate?.message === "string"
        ? candidate.message
        : "Foundry native validation failed.",
  };
}

function flattenValidationFailures(
  error: unknown,
  prefix = "$",
  visited = new Set<unknown>(),
): SchemaValidationIssue[] {
  if (!error || typeof error !== "object" || visited.has(error)) return [];
  visited.add(error);
  const value = error as Record<string, unknown> & {
    getAllFailures?: () => Record<string, { fieldPath?: string; message?: string }>;
  };
  if (typeof value.getAllFailures === "function") {
    const failures = value.getAllFailures();
    const entries = Object.entries(failures);
    if (entries.length > 0) {
      return entries.map(([key, failure]) => ({
        severity: "error",
        code: "NATIVE_VALIDATION",
        path:
          failure.fieldPath && failure.fieldPath !== "_source" ? failure.fieldPath : key || prefix,
        message:
          failure.message ||
          (typeof value.message === "string" ? value.message : "Validation failed."),
      }));
    }
  }
  const ownPath =
    typeof value["fieldPath"] === "string"
      ? (value["fieldPath"] as string)
      : typeof value["path"] === "string"
        ? (value["path"] as string)
        : prefix;
  const containers = [value["failures"], value["fields"], value["elements"], value["failure"]];
  const children: SchemaValidationIssue[] = [];
  for (const container of containers) {
    for (const [key, failure] of ownEntries(container)) {
      const path = ownPath === "$" ? key : `${ownPath}.${key}`;
      children.push(...flattenValidationFailures(failure, path, visited));
    }
  }
  if (children.length > 0) return children;
  if (typeof value["message"] === "string") {
    return [
      {
        severity: "error",
        code: "NATIVE_VALIDATION",
        path: ownPath,
        message: value["message"],
      },
    ];
  }
  return [];
}

function withCompatibilityWarnings<T>(operation: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const foundryGlobal = (
    globalThis as unknown as {
      foundry?: { utils?: { logCompatibilityWarning?: (...args: unknown[]) => unknown } };
    }
  ).foundry;
  const utils = foundryGlobal?.utils;
  const original = utils?.logCompatibilityWarning;
  let replaced = false;
  if (utils && original) {
    const wrapper = (...args: unknown[]) => {
      const message = args.find((value): value is string => typeof value === "string");
      if (message) warnings.push(message);
      return original(...args);
    };
    try {
      utils.logCompatibilityWarning = wrapper;
      replaced = utils.logCompatibilityWarning === wrapper;
    } catch {
      // Foundry 14 freezes portions of foundry.utils in the live client. Warning
      // capture is optional; validation itself must not fail when the hook is read-only.
    }
  }
  try {
    return { value: operation(), warnings };
  } finally {
    if (utils && original && replaced) {
      try {
        utils.logCompatibilityWarning = original;
      } catch {
        // The live v14 client can make this property read-only while a DataModel
        // operation is in progress. Restoration is best-effort warning plumbing
        // and must never turn a successful no-persist validation into an error.
      }
    }
  }
}

function validateSystemDataModel(
  model: RuntimeModelClass,
  candidate: Record<string, unknown>,
  mode: "create" | "update",
): { normalized: Record<string, unknown>; errors: SchemaValidationIssue[] } {
  try {
    const instance =
      mode === "create"
        ? new model(candidate, { clean: false, strict: true, fallback: false })
        : new model(candidate, { clean: false, strict: false, fallback: true });
    if (mode === "update") {
      instance.updateSource?.(candidate, {
        dryRun: true,
        recursive: true,
        fallback: false,
        clean: false,
      });
    }
    const valid =
      mode === "create"
        ? instance.validate?.({ clean: false, strict: true, fields: true, joint: true })
        : true;
    const normalized = mode === "create" ? (instance.toObject?.() ?? candidate) : candidate;
    return {
      normalized,
      errors:
        valid === false
          ? [
              {
                severity: "error",
                code: "NATIVE_VALIDATION",
                path: "system",
                message: "Foundry DataModel validation rejected the system candidate.",
              },
            ]
          : [],
    };
  } catch (error) {
    const flattened = flattenValidationFailures(error);
    const issues = flattened.length > 0 ? flattened : [nativeValidationIssue(error)];
    for (const issue of issues) {
      if (issue.path === "$") issue.path = "system";
      else if (!issue.path.startsWith("system.")) issue.path = `system.${issue.path}`;
    }
    return { normalized: candidate, errors: issues };
  }
}

function validateCoreDataFields(
  model: RuntimeModelClass,
  candidate: Record<string, unknown>,
  partial: boolean,
): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];
  for (const [name, field] of schemaFields(model)) {
    if (!field.validate || !(name in candidate)) continue;
    try {
      const failure = field.validate(candidate[name], {
        source: candidate,
        partial,
        strict: false,
        clean: false,
      });
      if (failure) {
        const flattened = flattenValidationFailures(failure, name);
        issues.push(
          ...(flattened.length > 0
            ? flattened
            : [
                {
                  severity: "error" as const,
                  code: "NATIVE_VALIDATION" as const,
                  path: name,
                  message: `Foundry DataField validation rejected "${name}".`,
                },
              ]),
        );
      }
    } catch (error) {
      const flattened = flattenValidationFailures(error, name);
      issues.push(...(flattened.length > 0 ? flattened : [nativeValidationIssue(error)]));
    }
  }
  return issues;
}

function hasValueAtPath(data: Record<string, unknown>, path: string): boolean {
  let current: unknown = data;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(part in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current !== undefined;
}

function isCompleteCandidate(
  data: Record<string, unknown>,
  fields: DiscoveredSchemaField[],
): boolean {
  return fields.every(
    (field) => !field.required || field.hasDefault || hasValueAtPath(data, field.path),
  );
}

export function discoverDocumentSchema(input: SchemaTargetInput): SchemaDiscoveryResult {
  const { context, fields, limitations } = resolveTarget(input);
  return { context, fields, limitations, readOnly: true };
}

function validateOneCandidate(
  input: SchemaValidationInput,
  data: Record<string, unknown>,
  index: number,
  resolved: ReturnType<typeof resolveTarget>,
): SchemaValidationResult {
  const before = stableSchemaValue(data);
  const { context, documentModel, systemModel, fields } = resolved;
  // Foundry owns DocumentStats on create and populates it during persistence.
  // It remains discoverable, but callers must never be required to forge it.
  const callerFields = fields.map((field) =>
    field.path === "_stats" || field.path.startsWith("_stats.")
      ? { ...field, required: false }
      : field,
  );
  const original = cloneSchemaCandidate(data);
  const originalInspection = validateDiscoveredFields(original, callerFields, input.mode);
  let normalized = cloneSchemaCandidate(data);
  const partial = input.mode === "update";
  let migrationWarnings: string[] = [];
  const limitations: string[] = [];
  const nativeErrors: SchemaValidationIssue[] = [];
  try {
    const migrated = withCompatibilityWarnings(() => {
      normalized = documentModel.migrateDataSafe?.(normalized) ?? normalized;
      normalized = cleanWithModel(documentModel, normalized, partial);
      nativeErrors.push(...validateCoreDataFields(documentModel, normalized, partial));
      const completeForJoint =
        input.mode === "create" || isCompleteCandidate(normalized, callerFields);
      if (completeForJoint) {
        (documentModel.schema as RuntimeSchema | undefined)?._validateModel?.(normalized);
        documentModel.validateJoint?.(normalized);
      } else {
        limitations.push(
          "Document-level joint validation was skipped because this update candidate is partial and no baseline document source was provided.",
        );
      }
      if (systemModel && normalized.system && typeof normalized.system === "object") {
        let systemCandidate = normalized.system as Record<string, unknown>;
        systemCandidate = systemModel.migrateDataSafe?.(systemCandidate) ?? systemCandidate;
        systemCandidate = cleanWithModel(systemModel, systemCandidate, partial);
        const native = validateSystemDataModel(
          systemModel,
          systemCandidate,
          input.mode === "update" && completeForJoint ? "create" : input.mode,
        );
        normalized.system = native.normalized;
        nativeErrors.push(...native.errors);
      }
      if (input.mode === "create") applyPortableDefaults(normalized, fields);
      return normalized;
    });
    normalized = migrated.value;
    migrationWarnings = migrated.warnings;
  } catch (error) {
    const flattened = flattenValidationFailures(error);
    nativeErrors.push(...(flattened.length > 0 ? flattened : [nativeValidationIssue(error)]));
  }

  // Type/enum/required checks happen after native cleaning so coercible input is accepted.
  const normalizedInspection = validateDiscoveredFields(normalized, callerFields, input.mode);
  const errors = [...normalizedInspection.errors, ...nativeErrors];
  return {
    index,
    context,
    mode: input.mode,
    valid: errors.length === 0,
    normalized,
    errors,
    // Unknown fields are intentionally derived from the original clone, before cleaners can drop them.
    warnings: originalInspection.warnings,
    inputUnchanged: before === stableSchemaValue(data),
    persisted: false,
    migrationWarnings,
    limitations,
  };
}

export function validateDocumentSchema(input: SchemaValidationInput): SchemaValidationBatchResult {
  const { context, documentModel, systemModel, fields } = resolveTarget(input);
  const candidates = input.candidates ?? (input.data ? [input.data] : []);
  if (candidates.length === 0 || (input.data && input.candidates)) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "Provide exactly one of data or a non-empty candidates array.",
      retryable: false,
      fieldPath: input.data && input.candidates ? "candidates" : "data",
    });
  }
  if (candidates.length > 100) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "Schema validation accepts at most 100 candidates per request.",
      retryable: false,
      fieldPath: "candidates",
    });
  }
  const resolved = { context, documentModel, systemModel, fields, limitations: [] };
  const results = candidates.map((candidate, index) =>
    validateOneCandidate(input, candidate, index, resolved),
  );
  return {
    context,
    mode: input.mode,
    results,
    validCount: results.filter(({ valid }) => valid).length,
    invalidCount: results.filter(({ valid }) => !valid).length,
    complete: true,
    persisted: false,
  };
}

registerCommand(SCHEMA_DISCOVERY_COMMANDS.DISCOVER, discoverDocumentSchema);
registerCommand(SCHEMA_DISCOVERY_COMMANDS.VALIDATE, validateDocumentSchema);
