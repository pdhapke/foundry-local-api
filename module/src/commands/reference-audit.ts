import {
  ProtocolError,
  REFERENCE_AUDIT_COMMAND,
  type ReferenceAuditClass,
  type ReferenceAuditInput,
  type ReferenceAuditIssue,
  type ReferenceAuditResult,
} from "@foundry-local-api/shared";
import { registerCommand } from "../command-registry.js";

const CLASSES: ReferenceAuditClass[] = [
  "uuid",
  "asset",
  "embedded",
  "note",
  "tokenActor",
  "folder",
  "ownership",
  "stableId",
  "tableResult",
];
const ASSET_TOKEN_PATTERN = /[^\s"'()<>{}[\],;]+/g;
const ASSET_EXTENSION_PATTERN = /\.(?:png|jpe?g|webp|gif|svg|mp3|ogg|wav|webm|mp4)(?=$|[?#])/i;
const UUID_PATTERN = /@UUID\[([^\]]+)\]/g;
const MAX_VALUES_PER_DOCUMENT = 100_000;
const MAX_STRING_CHARACTERS = 2_000_000;
const MAX_TOTAL_STRING_CHARACTERS_PER_DOCUMENT = 4_000_000;
const MAX_TRAVERSAL_DEPTH = 128;

type AuditDocument = FoundryDocument & {
  documentName?: string;
  uuid: string;
  toObject(): Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

interface WalkState {
  remaining: number;
  remainingStringCharacters: number;
  ancestors: Set<object>;
}

function walk(
  value: unknown,
  path: string,
  visit: (path: string, value: unknown) => void,
  state: WalkState = {
    remaining: MAX_VALUES_PER_DOCUMENT,
    remainingStringCharacters: MAX_TOTAL_STRING_CHARACTERS_PER_DOCUMENT,
    ancestors: new Set(),
  },
  depth = 0,
): void {
  state.remaining -= 1;
  if (state.remaining < 0 || depth > MAX_TRAVERSAL_DEPTH)
    throw new TypeError("Serialized document exceeded its traversal bound.");
  if (typeof value === "string") {
    if (value.length > MAX_STRING_CHARACTERS)
      throw new TypeError("Serialized field exceeded its character bound.");
    state.remainingStringCharacters -= value.length;
    if (state.remainingStringCharacters < 0)
      throw new TypeError("Serialized document exceeded its aggregate character bound.");
  }
  if (Array.isArray(value)) {
    if (state.ancestors.has(value)) throw new TypeError("Cyclic serialized document.");
    state.ancestors.add(value);
    visit(path, value);
    try {
      value.forEach((child, index) =>
        walk(child, path ? `${path}.${index}` : `${index}`, visit, state, depth + 1),
      );
    } finally {
      state.ancestors.delete(value);
    }
  } else if (value && typeof value === "object") {
    if (state.ancestors.has(value)) throw new TypeError("Cyclic serialized document.");
    state.ancestors.add(value);
    const wrapper = value as Record<string, unknown>;
    try {
      const descriptors = Object.getOwnPropertyDescriptors(wrapper);
      const source = asRecord(descriptors["_source"]?.value);
      // Foundry may leave embedded Document wrappers in otherwise serialized
      // payloads. Their immutable source is authoritative; traversing the live
      // wrapper as well duplicates findings and can invoke fragile compatibility
      // accessors such as TableResult.type.
      if (source) {
        walk(source, path, visit, state, depth + 1);
        return;
      }
      if (Object.values(descriptors).some((descriptor) => !("value" in descriptor)))
        throw new TypeError("Unreadable serialized field.");
      visit(path, value);
      for (const [key, descriptor] of Object.entries(descriptors))
        walk(descriptor.value, path ? `${path}.${key}` : key, visit, state, depth + 1);
    } finally {
      state.ancestors.delete(value);
    }
  } else visit(path, value);
}

export function auditReferences(input: ReferenceAuditInput): ReferenceAuditResult {
  if (!(game.user as unknown as { isGM?: boolean }).isGM)
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "Reference audit requires a GM executing client.",
      retryable: false,
    });
  const maxDocuments = Math.min(input.maxDocuments ?? 10_000, 10_000);
  const maxIssues = Math.min(input.maxIssues ?? 2_000, 2_000);
  const issues: ReferenceAuditIssue[] = [];
  const counts = new Map(CLASSES.map((kind) => [kind, 0]));
  const stableIds = new Map<string, string>();
  const incompleteReasons = new Map<ReferenceAuditClass, Set<string>>();
  let scannedDocuments = 0;
  let truncated = false;
  const fromUuidSync = (globalThis as any).fromUuidSync as ((uuid: string) => unknown) | undefined;
  const add = (issue: ReferenceAuditIssue) => {
    if (issues.length < maxIssues) issues.push(issue);
    else truncated = true;
  };
  const incomplete = (kind: ReferenceAuditClass, reason: string) => {
    const reasons = incompleteReasons.get(kind) ?? new Set<string>();
    reasons.add(reason);
    incompleteReasons.set(kind, reasons);
  };
  if (!fromUuidSync) {
    incomplete("uuid", "Synchronous UUID resolver unavailable.");
    incomplete("embedded", "Synchronous UUID resolver unavailable.");
    incomplete("tableResult", "Synchronous UUID resolver unavailable.");
  }
  if (input.includeDocumentTypes)
    for (const kind of CLASSES)
      incomplete(kind, "A document-type filter excludes campaign-wide coverage.");
  const resolve = (
    target: string,
    kind: ReferenceAuditClass,
    documentUuid: string,
    fieldPath: string,
  ) => {
    if (!fromUuidSync) {
      incomplete(kind, "Synchronous UUID resolver unavailable.");
      return undefined;
    }
    try {
      return fromUuidSync(target);
    } catch {
      incomplete(kind, "A UUID resolver threw while scanning this class.");
      add({
        class: kind,
        code: "RESOLVER_ERROR",
        documentUuid,
        fieldPath,
        target,
        message: "The target resolver failed; this reference class is incomplete.",
      });
      return undefined;
    }
  };
  const recordStableId = (stableId: string, location: string, fieldPath: string) => {
    const prior = stableIds.get(stableId);
    if (prior)
      add({
        class: "stableId",
        code: "DUPLICATE_STABLE_ID",
        documentUuid: location,
        fieldPath,
        target: stableId,
        message: `Stable ID is already used by ${prior}.`,
      });
    else stableIds.set(stableId, location);
  };
  outer: for (const [documentType, collection] of game.collections.entries()) {
    if (input.includeDocumentTypes && !input.includeDocumentTypes.includes(documentType)) continue;
    let documents: Iterable<unknown>;
    try {
      documents = collection.values();
    } catch {
      for (const kind of CLASSES) incomplete(kind, `Collection ${documentType} was inaccessible.`);
      continue;
    }
    for (const document of documents) {
      if (scannedDocuments >= maxDocuments) {
        truncated = true;
        break outer;
      }
      scannedDocuments += 1;
      let uuid: string;
      let data: Record<string, unknown>;
      try {
        const typed = document as AuditDocument;
        uuid = typed.uuid;
        data = typed.toObject();
      } catch {
        for (const kind of CLASSES)
          incomplete(kind, `A ${documentType} document could not be serialized.`);
        continue;
      }
      try {
        for (const kind of CLASSES) counts.set(kind, (counts.get(kind) ?? 0) + 1);
        walk(data, "", (fieldPath, value) => {
          if (value && typeof value === "object") {
            const embedded = value as Record<string, unknown>;
            if (typeof embedded["entryId"] === "string") {
              const entryId = embedded["entryId"];
              const entry = game.collections.get("JournalEntry")?.get(entryId) as
                { pages?: { get(id: string): unknown } } | undefined;
              if (!entry)
                add({
                  class: "note",
                  code: "BROKEN_NOTE_ENTRY",
                  documentUuid: uuid,
                  fieldPath: `${fieldPath}.entryId`,
                  target: entryId,
                  message: "Embedded Note Journal entry was not found.",
                });
              else if (
                typeof embedded["pageId"] === "string" &&
                !entry.pages?.get(embedded["pageId"])
              )
                add({
                  class: "note",
                  code: "BROKEN_NOTE_PAGE",
                  documentUuid: uuid,
                  fieldPath: `${fieldPath}.pageId`,
                  target: embedded["pageId"],
                  message: "Embedded Note Journal page was not found.",
                });
            }
            if (
              typeof embedded["actorId"] === "string" &&
              !game.collections.get("Actor")?.get(embedded["actorId"] as string)
            )
              add({
                class: "tokenActor",
                code: "BROKEN_TOKEN_ACTOR",
                documentUuid: uuid,
                fieldPath: `${fieldPath}.actorId`,
                target: embedded["actorId"] as string,
                message: "Embedded Token Actor was not found.",
              });
          }
          if (typeof value === "string") {
            for (const match of value.matchAll(UUID_PATTERN))
              if (match[1] && !resolve(match[1], "uuid", uuid, fieldPath))
                add({
                  class: "uuid",
                  code: "BROKEN_UUID",
                  documentUuid: uuid,
                  fieldPath,
                  target: match[1],
                  message: "UUID target was not found.",
                });
            for (const token of value.matchAll(ASSET_TOKEN_PATTERN)) {
              const extension = ASSET_EXTENSION_PATTERN.exec(token[0]);
              if (!extension) continue;
              add({
                class: "asset",
                code: "ASSET_REQUIRES_SERVER_CHECK",
                documentUuid: uuid,
                fieldPath,
                target: token[0].slice(0, extension.index + extension[0].length),
                message: "Asset path requires server-side existence validation.",
              });
            }
          }
          const candidate = asRecord(value);
          const flags = asRecord(candidate?.["flags"]);
          const moduleFlags = asRecord(flags?.["foundry-local-api"]);
          const stableId = moduleFlags?.["stableId"];
          if (typeof stableId === "string" && stableId)
            recordStableId(
              stableId,
              uuid,
              `${fieldPath ? `${fieldPath}.` : ""}flags.foundry-local-api.stableId`,
            );
          for (const key of ["parentUuid", "documentUuid", "targetUuid"] as const) {
            const target = candidate?.[key];
            if (
              typeof target === "string" &&
              target &&
              !resolve(target, "embedded", uuid, `${fieldPath}.${key}`)
            )
              add({
                class: "embedded",
                code: "BROKEN_EMBEDDED_REFERENCE",
                documentUuid: uuid,
                fieldPath: `${fieldPath}.${key}`,
                target,
                message: "Embedded-document reference was not found.",
              });
          }
        });
        // The collection key is the authoritative top-level document type and
        // avoids unnecessary compatibility getters on live Documents.
        const type = documentType;
        if (type === "Note") {
          const entryId = data["entryId"] as string | undefined;
          if (entryId && !game.collections.get("JournalEntry")?.get(entryId))
            add({
              class: "note",
              code: "BROKEN_NOTE_ENTRY",
              documentUuid: uuid,
              fieldPath: "entryId",
              target: entryId,
              message: "Note Journal entry was not found.",
            });
        }
        if (type === "Token" || type === "TokenDocument") {
          const actorId = data["actorId"] as string | undefined;
          if (actorId && !game.collections.get("Actor")?.get(actorId))
            add({
              class: "tokenActor",
              code: "BROKEN_TOKEN_ACTOR",
              documentUuid: uuid,
              fieldPath: "actorId",
              target: actorId,
              message: "Token Actor was not found.",
            });
        }
        const folderId =
          typeof data["folder"] === "string" ? data["folder"] : (data["folder"] as any)?._id;
        if (folderId && !game.collections.get("Folder")?.get(folderId))
          add({
            class: "folder",
            code: "BROKEN_FOLDER",
            documentUuid: uuid,
            fieldPath: "folder",
            target: folderId,
            message: "Folder was not found.",
          });
        const flags = data["flags"] as any;
        // The recursive pass above includes the top-level document.
        const campaignId = flags?.world?.izzyCampaignId as string | undefined;
        if (campaignId) {
          const key = `izzy:${campaignId}`;
          recordStableId(key, uuid, "flags.world.izzyCampaignId");
        }
        if (type === "RollTable") {
          const results = data["results"];
          if (!Array.isArray(results))
            add({
              class: "tableResult",
              code: "MALFORMED_TABLE_RESULTS",
              documentUuid: uuid,
              fieldPath: "results",
              message: "RollTable results are not an array.",
            });
          else
            results.forEach((raw, index) => {
              const wrapper = asRecord(raw);
              // Foundry v14 may retain embedded TableResult document wrappers in
              // a RollTable serialization. Their public `type` getter can read
              // transient null metadata; the immutable source is the audit-safe
              // representation and plain serialized results continue unchanged.
              const result = asRecord(wrapper?.["_source"]) ?? wrapper;
              if (!result) {
                add({
                  class: "tableResult",
                  code: "MALFORMED_TABLE_RESULT",
                  documentUuid: uuid,
                  fieldPath: `results.${index}`,
                  message: "RollTable result is not an object.",
                });
                return;
              }
              const collection = result["documentCollection"] ?? result["collection"];
              const documentId = result["documentId"] ?? result["resultId"];
              const typeValue = result["type"];
              const documentLike =
                typeValue === "document" ||
                typeValue === "compendium" ||
                typeValue === 1 ||
                typeValue === 2;
              if (
                documentLike &&
                (typeof collection !== "string" || typeof documentId !== "string")
              ) {
                add({
                  class: "tableResult",
                  code: "MALFORMED_TABLE_RESULT",
                  documentUuid: uuid,
                  fieldPath: `results.${index}`,
                  message: "Document RollTable result lacks a collection or document ID.",
                });
                return;
              }
              if (documentLike) {
                const collectionName = collection as string;
                const compendiumLike = typeValue === "compendium" || typeValue === 2;
                const target = `${
                  compendiumLike && !collectionName.startsWith("Compendium.")
                    ? `Compendium.${collectionName}`
                    : collectionName
                }.${documentId as string}`;
                if (!resolve(target, "tableResult", uuid, `results.${index}`))
                  add({
                    class: "tableResult",
                    code: "BROKEN_TABLE_RESULT",
                    documentUuid: uuid,
                    fieldPath: `results.${index}`,
                    target,
                    message: "RollTable result target was not found.",
                  });
              }
            });
        }
        if (
          flags?.["foundry-local-api"]?.gmOnly === true &&
          Object.entries((data["ownership"] as Record<string, number> | undefined) ?? {}).some(
            ([userId, level]) => {
              if (level <= 0) return false;
              if (userId === "default") return true;
              const user = (game as any).users?.get?.(userId) as { isGM?: boolean } | undefined;
              return user ? !user.isGM : true;
            },
          )
        )
          add({
            class: "ownership",
            code: "GM_ONLY_OWNERSHIP_LEAK",
            documentUuid: uuid,
            fieldPath: "ownership",
            message: "GM-only document grants nonzero ownership.",
          });
      } catch {
        for (const kind of CLASSES)
          incomplete(kind, `A ${documentType} document could not be audited completely.`);
        add({
          class: "tableResult",
          code: "DOCUMENT_AUDIT_ERROR",
          documentUuid: uuid,
          fieldPath: "",
          message:
            "A document exposed unreadable live fields; its reference coverage is incomplete.",
        });
      }
      if (truncated) break outer;
    }
  }
  incomplete("asset", "Filesystem existence validation must be completed by the server endpoint.");
  const classes = CLASSES.map((kind) => ({
    class: kind,
    complete: !truncated && !incompleteReasons.has(kind),
    scanned: counts.get(kind) ?? 0,
    issueCount: issues.filter((issue) => issue.class === kind).length,
    ...(incompleteReasons.has(kind)
      ? { reason: [...incompleteReasons.get(kind)!].join(" ") }
      : truncated
        ? { reason: "The audit was truncated before this class completed." }
        : {}),
  }));
  const complete = classes.every((entry) => entry.complete);
  return {
    clean: complete ? issues.length === 0 : null,
    complete,
    scannedDocuments,
    classes,
    issues,
    truncated,
  };
}

registerCommand(REFERENCE_AUDIT_COMMAND, async (input: ReferenceAuditInput) =>
  auditReferences(input),
);
