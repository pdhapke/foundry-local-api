import {
  WORLD_DOCUMENT_TYPES,
  WORLD_DOCUMENT_COMMANDS,
  type WorldDocumentRead,
  type WorldDocumentApply,
  type WorldDocumentSource,
  type WorldDocumentList,
} from "@foundry-local-api/shared";
import { registerCommand } from "../command-registry.js";
import { validateDocumentGuard } from "../document-guards.js";
type Doc = FoundryDocument & {
  getEmbeddedCollection(name: string): Map<string, Doc>;
  delete(options: Record<string, unknown>): Promise<unknown>;
};
function fail(message: string): never {
  throw new Error(message);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "_stats")
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
async function revision(source: Record<string, unknown>): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(canonical(source)));
  if (encoded.byteLength > 24000) fail("World document source exceeds bounded 24k UTF8 budget");
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoded))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
function authorize(input: WorldDocumentRead | WorldDocumentApply): void {
  if (
    input.worldId !== game.world.id ||
    !game.user.isGM ||
    !game.user.active ||
    game.user.id !== input.requestingUserId ||
    !game.users.get(input.requestingUserId)?.isGM ||
    !game.users.get(input.requestingUserId)?.active
  )
    fail("Live active-world GM authorization required");
  if (!Object.hasOwn(WORLD_DOCUMENT_TYPES, input.family)) fail("Unsupported world document family");
  for (const id of [input.targetId, input.parentId, input.worldId, input.requestingUserId])
    if (id !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail("Invalid scoped identifier");
}
function collection(input: WorldDocumentRead | WorldDocumentApply): {
  documents: Map<string, Doc>;
  parent?: Doc;
} {
  const family = WORLD_DOCUMENT_TYPES[input.family];
  if ("parent" in family) {
    if (!input.parentId) fail("Typed parent required");
    const parent = game.collections.get(family.parent)?.get(input.parentId) as Doc | undefined;
    if (!parent) fail("World parent missing");
    return { parent, documents: parent.getEmbeddedCollection(family.type) };
  }
  if (input.parentId) fail("Unexpected parent");
  const documents = game.collections.get(family.type) as Map<string, Doc> | undefined;
  if (!documents) fail("World collection unavailable");
  return { documents };
}
export async function readWorldDocument(
  input: WorldDocumentRead,
): Promise<WorldDocumentSource | WorldDocumentList> {
  authorize(input);
  const { documents } = collection(input);
  if (input.operation === "list") {
    const offset = input.offset ?? 0,
      limit = input.limit ?? 20;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 100000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      fail("Invalid pagination");
    const sorted = [...documents.values()].sort((a, b) => a.id.localeCompare(b.id));
    const summaries = [];
    for (const doc of sorted.slice(offset, offset + limit)) {
      const source = doc.toObject();
      summaries.push({
        id: doc.id,
        name: String(source["name"] ?? "").slice(0, 120),
        ...(typeof source["type"] === "string" ? { type: source["type"].slice(0, 100) } : {}),
        revision: await revision(source),
      });
    }
    authorize(input);
    return {
      worldId: game.world.id,
      family: input.family,
      operation: "list",
      ...(input.parentId ? { parentId: input.parentId } : {}),
      documents: summaries,
      nextOffset: offset + limit < sorted.length ? offset + limit : null,
    };
  }
  if (input.operation !== "get" || !input.targetId) fail("Get target required");
  const source = documents.get(input.targetId)?.toObject() ?? null;
  const hash = source ? await revision(source) : null;
  authorize(input);
  return {
    worldId: game.world.id,
    family: input.family,
    operation: "get",
    targetId: input.targetId,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    source,
    revision: hash,
  };
}
function validateData(data: Record<string, unknown>): boolean {
  let sensitive = false;
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!value || typeof value !== "object") {
      if (
        typeof value === "string" &&
        /<script\b|\bon\w+\s*=|javascript:|^macro[.]/i.test(value.trim())
      )
        fail("Executable content requires separate code executor");
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        /(?:^|\.)type$/i.test(key) &&
        typeof child === "string" &&
        /^(?:executeScript|executeMacro)$/i.test(child)
      )
        fail("Executable Region behavior requires separate code executor");
      if (
        /(?:^|\.)(?:__proto__|prototype|constructor|_stats|_source|pack|parent)(?:\.|$)|(?:^|\.)-=/i.test(
          key,
        )
      )
        fail("Unsafe document data key");
      if (
        /(?:^|\.)(?:command|script|macro|dae|itemacro|onUpdateTarget|onUpdateSource|onUseMacroName|onUseMacroParts)(?:\.|$)/i.test(
          key,
        )
      )
        fail("Executable content requires separate code executor");
      if (
        /(?:^|\.)(?:ownership|permission|items|effects|pages|tokens|walls|regions|behaviors)(?:\.|$)/i.test(
          key,
        )
      )
        sensitive = true;
      visit(child);
    }
  };
  visit(data);
  return sensitive;
}
function matches(source: Record<string, unknown>, data: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(data)) {
    let actual: unknown = source;
    for (const part of key.split("."))
      actual =
        actual && typeof actual === "object"
          ? (actual as Record<string, unknown>)[part]
          : undefined;
    if (key === "levels" && Array.isArray(expected)) {
      if (
        !Array.isArray(actual) ||
        actual.length !== expected.length ||
        !expected.every((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return false;
          const request = value as Record<string, unknown>;
          const found = actual.find(
            (child) =>
              child &&
              typeof child === "object" &&
              (child as Record<string, unknown>)["_id"] === request["_id"],
          );
          return found && matches(found as Record<string, unknown>, request);
        })
      )
        return false;
    } else if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (
        !actual ||
        typeof actual !== "object" ||
        !matches(actual as Record<string, unknown>, expected as Record<string, unknown>)
      )
        return false;
    } else if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected)))
      return false;
  }
  return true;
}
function rejectExecutableBehaviorTypes(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      /(?:^|\.)type$/i.test(key) &&
      typeof child === "string" &&
      /^(?:executeScript|executeMacro)$/i.test(child)
    )
      fail("Executable Region behavior requires separate code executor");
    rejectExecutableBehaviorTypes(child);
  }
}
const preparationLanes = new Map<string, Promise<void>>();
export async function applyWorldDocument(input: WorldDocumentApply): Promise<WorldDocumentSource> {
  const key = `${input.worldId}:${input.parentId ?? (input.family === "scenes" ? input.targetId : input.family)}`;
  const prior = preparationLanes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const owned = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.then(() => owned);
  preparationLanes.set(key, tail);
  await prior;
  try {
    return await applyWorldDocumentInLane(input);
  } finally {
    release();
    if (preparationLanes.get(key) === tail) preparationLanes.delete(key);
  }
}
async function applyWorldDocumentInLane(input: WorldDocumentApply): Promise<WorldDocumentSource> {
  authorize(input);
  if (
    !["create", "update", "delete"].includes(input.operation) ||
    !input.targetId ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.correlationId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)
  )
    fail("Exact server target/correlation/idempotency required");
  if (input.expectedRevision !== null && !/^[a-f0-9]{64}$/.test(input.expectedRevision))
    fail("Expected source revision required");
  const data = input.data ?? {};
  if (input.operation === "delete" && input.data !== undefined) fail("Delete data forbidden");
  if (
    input.operation !== "delete" &&
    (!input.data || typeof input.data !== "object" || Array.isArray(input.data))
  )
    fail("Document data required");
  if (Object.hasOwn(data, "_id") && data["_id"] !== input.targetId) fail("Document ID mismatch");
  if ((input.operation === "delete" || validateData(data)) && input.reviewedDestructive !== true)
    fail("Exact trusted destructive review required");
  await revision(data);
  const before = (await readWorldDocument({ ...input, operation: "get" })) as WorldDocumentSource;
  // A partial update may omit the existing executable behavior's type.
  // Code-bearing documents require their separate executor even for partial patches.
  if (input.operation === "update" && before.source) rejectExecutableBehaviorTypes(before.source);
  if (before.revision !== input.expectedRevision) fail("Stale world document revision");
  if (
    (input.operation === "create" && before.source !== null) ||
    (input.operation !== "create" && before.source === null)
  )
    fail("World target existence mismatch");
  // Hashing awaits: recapture source and synchronously compare canonical bytes,
  // then dispatch without another await. This is preflight, not core atomic CAS.
  authorize(input);
  const { documents, parent } = collection(input);
  const doc = documents.get(input.targetId);
  const current = doc?.toObject() ?? null;
  if (JSON.stringify(canonical(current)) !== JSON.stringify(canonical(before.source)))
    fail("World document changed before dispatch");
  if (input.preparationGuard) {
    validateDocumentGuard("preparation", { input, data, source: (parent ?? doc)?.toObject() });
  }
  const options = {
    ...(parent ? { parent } : {}),
    keepId: true,
    correlationId: input.correlationId,
    foundryLocalApi: { authorizedGmMovement: true },
    foundryLocalApiOrigin: {
      source: "foundry-local-api.world-document",
      phase: "apply",
      correlationId: input.correlationId,
    },
  };
  if (input.operation === "create") {
    const klass = CONFIG[WORLD_DOCUMENT_TYPES[input.family].type]?.documentClass;
    if (!klass) fail("Supported world document class unavailable");
    await klass.create({ ...data, _id: input.targetId }, options);
  } else if (input.operation === "update") await doc!.update(data, options);
  else await doc!.delete(options);
  const after = (await readWorldDocument({ ...input, operation: "get" })) as WorldDocumentSource;
  if (
    input.operation === "delete"
      ? after.source !== null
      : !after.source || !matches(after.source, data)
  )
    fail("World document read-back mismatch; result uncertain");
  return {
    ...after,
    operation: input.operation,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    verified: true,
  };
}
registerCommand(WORLD_DOCUMENT_COMMANDS.READ, readWorldDocument);
registerCommand(WORLD_DOCUMENT_COMMANDS.APPLY, applyWorldDocument);
