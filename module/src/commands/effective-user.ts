import {
  EFFECTIVE_USER_COMMANDS,
  ProtocolError,
  type EffectiveUserCommandInput,
  type EffectiveUserCommandResult,
  type EffectiveUserJournalPageData,
  type EffectiveUserOperation,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

interface PermissionAwareDocument extends FoundryDocument {
  testUserPermission?:
    ((user: FoundryUser, permission: "OBSERVER" | "OWNER") => boolean) | undefined;
}

interface EffectiveUserScene extends PermissionAwareDocument {
  getEmbeddedCollection(embeddedName: string): Map<string, PermissionAwareDocument>;
}

const MAX_JOURNAL_PAGES = 100;
const MAX_JOURNAL_CONTENT = 32_768;

function invalid(message: string, fieldPath: string): never {
  throw new ProtocolError({
    code: "INVALID_PAYLOAD",
    message,
    retryable: false,
    fieldPath,
  });
}

function assertId(value: unknown, fieldPath: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    invalid(`${fieldPath} must be a 1-128 character string.`, fieldPath);
  }
}

function assertOperation(value: unknown): asserts value is EffectiveUserOperation {
  if (typeof value !== "object" || value === null) invalid("operation is required.", "operation");
  const operation = value as Record<string, unknown>;
  switch (operation["kind"]) {
    case "inspectActorControl":
      assertId(operation["actorId"], "operation.actorId");
      return;
    case "applyActorOwnerProbe":
      assertId(operation["actorId"], "operation.actorId");
      assertId(operation["testRunId"], "operation.testRunId");
      if (!/^test-[A-Za-z0-9][A-Za-z0-9._-]+$/.test(operation["testRunId"] as string))
        invalid("operation.testRunId is not a valid fixture run ID.", "operation.testRunId");
      if (
        operation["probeValue"] !== null &&
        (typeof operation["probeValue"] !== "string" || operation["probeValue"].length > 128)
      )
        invalid(
          "operation.probeValue must be null or at most 128 characters.",
          "operation.probeValue",
        );
      if (
        typeof operation["expectedRevision"] !== "string" ||
        !/^[a-f0-9]{64}$/.test(operation["expectedRevision"])
      )
        invalid(
          "operation.expectedRevision must be a SHA-256 revision.",
          "operation.expectedRevision",
        );
      return;
    case "readJournalContent":
      assertId(operation["journalEntryId"], "operation.journalEntryId");
      if (operation["pageId"] !== undefined) assertId(operation["pageId"], "operation.pageId");
      return;
    case "inspectSceneToken":
      assertId(operation["sceneId"], "operation.sceneId");
      assertId(operation["tokenId"], "operation.tokenId");
      return;
    case "inspectNoteAccess":
      assertId(operation["sceneId"], "operation.sceneId");
      assertId(operation["noteId"], "operation.noteId");
      return;
    default:
      invalid("Operation is not in the effective-user allowlist.", "operation.kind");
  }
}

function requirePlayerContext(input: EffectiveUserCommandInput): FoundryUser {
  assertId(input.requestingUserId, "requestingUserId");
  assertId(input.effectiveUserId, "effectiveUserId");
  if (game.user.id !== input.effectiveUserId) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "The executing Foundry client does not match the requested effective user.",
      retryable: false,
      details: { effectiveUserId: input.effectiveUserId, executingUserId: game.user.id },
    });
  }
  if (game.user.isGM) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "GM escalation is not permitted through effective-user execution.",
      retryable: false,
    });
  }
  return game.user;
}

function hasPermission(
  document: PermissionAwareDocument | undefined,
  user: FoundryUser,
  permission: "OBSERVER" | "OWNER",
): boolean {
  try {
    return document?.testUserPermission?.(user, permission) === true;
  } catch {
    return false;
  }
}

function requireWorldDocument(documentType: string, documentId: string): PermissionAwareDocument {
  const document = game.collections.get(documentType)?.get(documentId) as
    PermissionAwareDocument | undefined;
  if (!document) {
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: "Document is unavailable to the effective user.",
      retryable: false,
    });
  }
  return document;
}

function denyUnavailable(permission: "OBSERVER" | "OWNER"): never {
  throw new ProtocolError({
    code: permission === "OWNER" ? "PERMISSION_DENIED" : "NOT_FOUND",
    message: `Document is unavailable or does not grant ${permission} permission to the effective user.`,
    retryable: false,
  });
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "_stats")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

async function documentRevision(source: Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(source)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ownerProbeValue(source: Record<string, unknown>): string | null {
  const flags = source["flags"] as Record<string, unknown> | undefined;
  const moduleFlags = flags?.["foundry-local-api"] as Record<string, unknown> | undefined;
  return typeof moduleFlags?.["ownerActionProbe"] === "string"
    ? moduleFlags["ownerActionProbe"]
    : null;
}

function fixtureRunId(source: Record<string, unknown>): string | null {
  const flags = source["flags"] as Record<string, unknown> | undefined;
  const moduleFlags = flags?.["foundry-local-api"] as Record<string, unknown> | undefined;
  return typeof moduleFlags?.["testRunId"] === "string" ? moduleFlags["testRunId"] : null;
}

function sanitizePlayerJournalContent(content: string): string {
  if (typeof DOMParser !== "undefined") {
    const parsed = new DOMParser().parseFromString(content, "text/html");
    for (const secret of Array.from(
      parsed.querySelectorAll('.secret, [data-visibility="gm"], [data-visibility="owner"]'),
    )) {
      secret.remove();
    }
    return parsed.body.innerHTML;
  }
  // Node test fallback. The live Foundry browser always uses DOMParser above.
  let sanitized = content;
  const restrictedElement =
    /<([a-z][\w:-]*)\b(?=[^>]*(?:class\s*=\s*["'][^"']*\bsecret\b[^"']*["']|data-visibility\s*=\s*["'](?:gm|owner)["']))[^>]*>[\s\S]*?<\/\1\s*>/gi;
  let previous: string;
  do {
    previous = sanitized;
    sanitized = sanitized.replace(restrictedElement, "");
  } while (sanitized !== previous);
  return sanitized;
}

function journalPageData(page: PermissionAwareDocument): EffectiveUserJournalPageData {
  const source = page.toObject();
  const text =
    typeof source["text"] === "object" && source["text"] !== null
      ? (source["text"] as Record<string, unknown>)
      : {};
  const fullContent = sanitizePlayerJournalContent(
    typeof text["content"] === "string" ? text["content"] : "",
  );
  return {
    pageId: page.id,
    name: nullableString(source["name"]),
    type: nullableString(source["type"]),
    textFormat: typeof text["format"] === "number" ? text["format"] : null,
    content: fullContent.slice(0, MAX_JOURNAL_CONTENT),
    truncated: fullContent.length > MAX_JOURNAL_CONTENT,
  };
}

export async function executeEffectiveUserOperation(
  input: EffectiveUserCommandInput,
): Promise<EffectiveUserCommandResult> {
  if (typeof input !== "object" || input === null) invalid("Request body is required.", "input");
  assertOperation(input.operation);
  const user = requirePlayerContext(input);

  if (input.operation.kind === "inspectActorControl") {
    const actor = requireWorldDocument("Actor", input.operation.actorId);
    if (!hasPermission(actor, user, "OWNER")) denyUnavailable("OWNER");
    const source = actor.toObject();
    return {
      effectiveUserId: user.id,
      operation: input.operation.kind,
      permissionDecision: { allowed: true, requiredPermission: "OWNER" },
      mutationIds: [],
      data: {
        kind: "actorControl",
        actorId: actor.id,
        name: nullableString(source["name"]),
        canObserve: true,
        canControl: true,
        revision: await documentRevision(source),
      },
    };
  }

  if (input.operation.kind === "applyActorOwnerProbe") {
    const actor = requireWorldDocument("Actor", input.operation.actorId);
    if (!hasPermission(actor, user, "OWNER")) denyUnavailable("OWNER");
    const beforeSource = actor.toObject();
    if (fixtureRunId(beforeSource) !== input.operation.testRunId) {
      throw new ProtocolError({
        code: "PERMISSION_DENIED",
        message: "Applied owner actions are restricted to the exact synthetic fixture run.",
        retryable: false,
        fieldPath: "operation.testRunId",
      });
    }
    const beforeRevision = await documentRevision(beforeSource);
    if (beforeRevision !== input.operation.expectedRevision) {
      throw new ProtocolError({
        code: "STALE_REVISION",
        message: "The fixture Actor changed after it was inspected.",
        retryable: true,
        fieldPath: "operation.expectedRevision",
        details: { expected: input.operation.expectedRevision, actual: beforeRevision },
      });
    }
    const beforeValue = ownerProbeValue(beforeSource);
    try {
      await actor.update({
        "flags.foundry-local-api.ownerActionProbe": input.operation.probeValue,
      });
      const readback = requireWorldDocument("Actor", input.operation.actorId);
      const afterSource = readback.toObject();
      const afterValue = ownerProbeValue(afterSource);
      if (afterValue !== input.operation.probeValue) {
        throw new ProtocolError({
          code: "INCOMPLETE_RESULT",
          message: "The fixture Actor owner action did not match independent readback.",
          retryable: false,
        });
      }
      return {
        effectiveUserId: user.id,
        operation: input.operation.kind,
        permissionDecision: { allowed: true, requiredPermission: "OWNER" },
        mutationIds: [actor.id],
        data: {
          kind: "actorOwnerProbe",
          actorId: actor.id,
          testRunId: input.operation.testRunId,
          beforeValue,
          afterValue,
          beforeRevision,
          afterRevision: await documentRevision(afterSource),
          readbackVerified: true,
        },
      };
    } catch (error) {
      try {
        await actor.update({ "flags.foundry-local-api.ownerActionProbe": beforeValue });
        const restored = requireWorldDocument("Actor", input.operation.actorId).toObject();
        if (ownerProbeValue(restored) !== beforeValue)
          throw new Error("Owner probe restore mismatch.");
      } catch {
        throw new ProtocolError({
          code: "ROLLBACK_FAILED",
          message: "The owner action failed and its exact probe value could not be restored.",
          retryable: false,
        });
      }
      throw error;
    }
  }

  if (input.operation.kind === "readJournalContent") {
    const journal = requireWorldDocument("JournalEntry", input.operation.journalEntryId);
    if (!hasPermission(journal, user, "OBSERVER")) denyUnavailable("OBSERVER");
    const pages = (journal as unknown as { pages?: Map<string, PermissionAwareDocument> }).pages;
    if (!(pages instanceof Map)) {
      throw new ProtocolError({
        code: "UNSUPPORTED_TYPE",
        message: "The JournalEntry does not expose embedded pages on this Foundry version.",
        retryable: false,
      });
    }
    const candidates = input.operation.pageId
      ? [pages.get(input.operation.pageId)].filter(
          (page): page is PermissionAwareDocument => page !== undefined,
        )
      : [...pages.values()].slice(0, MAX_JOURNAL_PAGES);
    if (input.operation.pageId && candidates.length === 0) denyUnavailable("OBSERVER");
    const visiblePages = candidates.filter((page) => hasPermission(page, user, "OBSERVER"));
    if (input.operation.pageId && visiblePages.length === 0) denyUnavailable("OBSERVER");
    const source = journal.toObject();
    return {
      effectiveUserId: user.id,
      operation: input.operation.kind,
      permissionDecision: { allowed: true, requiredPermission: "OBSERVER" },
      mutationIds: [],
      data: {
        kind: "journalContent",
        journalEntryId: journal.id,
        name: nullableString(source["name"]),
        pages: visiblePages.map(journalPageData),
      },
    };
  }

  const scene = requireWorldDocument("Scene", input.operation.sceneId) as EffectiveUserScene;
  if (!hasPermission(scene, user, "OBSERVER")) denyUnavailable("OBSERVER");

  if (input.operation.kind === "inspectSceneToken") {
    const token = scene.getEmbeddedCollection("Token").get(input.operation.tokenId);
    if (!token || !hasPermission(token, user, "OBSERVER")) denyUnavailable("OBSERVER");
    const source = token.toObject();
    if (source["hidden"] === true) denyUnavailable("OBSERVER");
    const sight =
      typeof source["sight"] === "object" && source["sight"] !== null
        ? (source["sight"] as Record<string, unknown>)
        : {};
    const actorId = nullableString(source["actorId"]);
    const actor = actorId
      ? (game.collections.get("Actor")?.get(actorId) as PermissionAwareDocument | undefined)
      : undefined;
    return {
      effectiveUserId: user.id,
      operation: input.operation.kind,
      permissionDecision: { allowed: true, requiredPermission: "OBSERVER" },
      mutationIds: [],
      data: {
        kind: "sceneToken",
        sceneId: scene.id,
        tokenId: token.id,
        name: nullableString(source["name"]),
        actorId,
        canObserve: true,
        canControl: hasPermission(token, user, "OWNER") || hasPermission(actor, user, "OWNER"),
        hidden: false,
        position: {
          x: finiteNumber(source["x"]),
          y: finiteNumber(source["y"]),
          elevation: finiteNumber(source["elevation"]),
        },
        vision: {
          enabled: sight["enabled"] === true,
          range: typeof sight["range"] === "number" ? sight["range"] : null,
          angle: typeof sight["angle"] === "number" ? sight["angle"] : null,
          mode: nullableString(sight["visionMode"]),
        },
      },
    };
  }

  const note = scene.getEmbeddedCollection("Note").get(input.operation.noteId);
  if (!note || !hasPermission(note, user, "OBSERVER")) denyUnavailable("OBSERVER");
  const source = note.toObject();
  if (source["hidden"] === true) denyUnavailable("OBSERVER");
  const journalEntryId = nullableString(source["entryId"]);
  const pageId = nullableString(source["pageId"]);
  if (journalEntryId) {
    const journal = game.collections.get("JournalEntry")?.get(journalEntryId) as
      (PermissionAwareDocument & { pages?: Map<string, PermissionAwareDocument> }) | undefined;
    if (!hasPermission(journal, user, "OBSERVER")) denyUnavailable("OBSERVER");
    if (pageId && !hasPermission(journal?.pages?.get(pageId), user, "OBSERVER")) {
      denyUnavailable("OBSERVER");
    }
  }
  return {
    effectiveUserId: user.id,
    operation: input.operation.kind,
    permissionDecision: { allowed: true, requiredPermission: "OBSERVER" },
    mutationIds: [],
    data: {
      kind: "noteAccess",
      sceneId: scene.id,
      noteId: note.id,
      journalEntryId,
      pageId,
      canObserve: true,
      hidden: false,
      position: { x: finiteNumber(source["x"]), y: finiteNumber(source["y"]) },
    },
  };
}

registerCommand(EFFECTIVE_USER_COMMANDS.EXECUTE, executeEffectiveUserOperation);
