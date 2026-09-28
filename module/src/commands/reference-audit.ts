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
  let scannedDocuments = 0;
  let truncated = false;
  const fromUuidSync = (globalThis as any).fromUuidSync as ((uuid: string) => unknown) | undefined;
  const add = (issue: ReferenceAuditIssue) => {
    if (issues.length < maxIssues) issues.push(issue);
    else truncated = true;
  };
  outer: for (const [documentType, collection] of game.collections.entries()) {
    if (input.includeDocumentTypes && !input.includeDocumentTypes.includes(documentType)) continue;
    for (const document of collection.values()) {
      if (scannedDocuments++ >= maxDocuments) {
        truncated = true;
        break outer;
      }
      const uuid = (document as FoundryDocument & { uuid: string }).uuid;
      const data = document.toObject() as Record<string, unknown>;
      for (const kind of CLASSES) counts.set(kind, (counts.get(kind) ?? 0) + 1);
      walk(data, "", (fieldPath, value) => {
        if (value && typeof value === "object") {
          const embedded = value as Record<string, unknown>;
          if (
            typeof embedded["entryId"] === "string" &&
            !game.collections.get("JournalEntry")?.get(embedded["entryId"] as string)
          )
            add({
              class: "note",
              code: "BROKEN_NOTE_ENTRY",
              documentUuid: uuid,
              fieldPath: `${fieldPath}.entryId`,
              target: embedded["entryId"] as string,
              message: "Embedded Note Journal entry was not found.",
            });
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
            if (fromUuidSync && match[1] && !fromUuidSync(match[1]))
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
      const stableId = flags?.["foundry-local-api"]?.stableId as string | undefined;
      if (stableId) {
        const prior = stableIds.get(stableId);
        if (prior)
          add({
            class: "stableId",
            code: "DUPLICATE_STABLE_ID",
            documentUuid: uuid,
            fieldPath: "flags.foundry-local-api.stableId",
            target: stableId,
            message: `Stable ID is already used by ${prior}.`,
          });
        else stableIds.set(stableId, uuid);
      }
      const campaignId = flags?.world?.izzyCampaignId as string | undefined;
      if (campaignId) {
        const key = `izzy:${campaignId}`;
        const prior = stableIds.get(key);
        if (prior)
          add({
            class: "stableId",
            code: "DUPLICATE_STABLE_ID",
            documentUuid: uuid,
            fieldPath: "flags.world.izzyCampaignId",
            target: campaignId,
            message: `Campaign stable ID is already used by ${prior}.`,
          });
        else stableIds.set(key, uuid);
      }
      if (
        flags?.["foundry-local-api"]?.gmOnly === true &&
        Object.values((data["ownership"] as Record<string, number> | undefined) ?? {}).some(
          (level) => level > 0,
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
  const unsupportedReasons: Partial<Record<ReferenceAuditClass, string>> = {
    asset:
      "Filesystem validation and typed FilePath coverage are performed by the server audit endpoint.",
    embedded: "General embedded-document reference relationships are not yet exhaustively modeled.",
    note: "Journal page linkage is not yet validated for every embedded Note.",
    ownership: "Cross-user disclosure checks are not yet evaluated for every requested user.",
    stableId: "Stable IDs on every embedded document are not yet included.",
    tableResult: "RollTable result structure and target resolution are not yet validated.",
  };
  const classes = CLASSES.map((kind) => ({
    class: kind,
    complete:
      !truncated && (kind !== "uuid" || !!fromUuidSync) && unsupportedReasons[kind] === undefined,
    scanned: counts.get(kind) ?? 0,
    issueCount: issues.filter((issue) => issue.class === kind).length,
    ...(unsupportedReasons[kind]
      ? { reason: unsupportedReasons[kind] }
      : !fromUuidSync && kind === "uuid"
        ? { reason: "Synchronous UUID resolver unavailable." }
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
