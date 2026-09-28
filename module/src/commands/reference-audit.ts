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
const ASSET_PATTERN = /(?:[^\s"']+\.(?:png|jpe?g|webp|gif|svg|mp3|ogg|wav|webm|mp4))/gi;
const UUID_PATTERN = /@UUID\[([^\]]+)\]/g;

type AuditDocument = FoundryDocument & {
  documentName?: string;
  uuid: string;
  toObject(): Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function walk(value: unknown, path: string, visit: (path: string, value: unknown) => void): void {
  visit(path, value);
  if (Array.isArray(value)) value.forEach((child, index) => walk(child, `${path}.${index}`, visit));
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
      walk(child, path ? `${path}.${key}` : key, visit);
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
      if (scannedDocuments++ >= maxDocuments) {
        truncated = true;
        break outer;
      }
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
          for (const match of value.matchAll(ASSET_PATTERN))
            add({
              class: "asset",
              code: "ASSET_REQUIRES_SERVER_CHECK",
              documentUuid: uuid,
              fieldPath,
              target: match[0],
              message: "Asset path requires server-side existence validation.",
            });
        }
      });
      walk(data, "", (fieldPath, value) => {
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
      const type = (document as any).documentName ?? documentType;
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
            const result = asRecord(raw);
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
