/** Bounded, read-only operations which execute on an explicitly opted-in player client. */
export const EFFECTIVE_USER_COMMANDS = {
  EXECUTE: "effectiveUserExecute",
} as const;

export interface EffectiveUserActorControlOperation {
  kind: "inspectActorControl";
  actorId: string;
}

export interface EffectiveUserActorOwnerProbeOperation {
  kind: "applyActorOwnerProbe";
  actorId: string;
  testRunId: string;
  probeValue: string | null;
  expectedRevision: string;
}

export interface EffectiveUserJournalOperation {
  kind: "readJournalContent";
  journalEntryId: string;
  pageId?: string | undefined;
}

export interface EffectiveUserSceneTokenOperation {
  kind: "inspectSceneToken";
  sceneId: string;
  tokenId: string;
}

export interface EffectiveUserNoteOperation {
  kind: "inspectNoteAccess";
  sceneId: string;
  noteId: string;
}

export type EffectiveUserOperation =
  | EffectiveUserActorControlOperation
  | EffectiveUserActorOwnerProbeOperation
  | EffectiveUserJournalOperation
  | EffectiveUserSceneTokenOperation
  | EffectiveUserNoteOperation;

export interface EffectiveUserExecuteInput {
  effectiveUserId: string;
  operation: EffectiveUserOperation;
}

/** Internal bridge input; the server derives this identity from the negotiated GM lane. */
export interface EffectiveUserCommandInput extends EffectiveUserExecuteInput {
  requestingUserId: string;
}

export interface EffectiveUserActorControlData {
  kind: "actorControl";
  actorId: string;
  name: string | null;
  canObserve: true;
  canControl: true;
  revision: string;
}

export interface EffectiveUserActorOwnerProbeData {
  kind: "actorOwnerProbe";
  actorId: string;
  testRunId: string;
  beforeValue: string | null;
  afterValue: string | null;
  beforeRevision: string;
  afterRevision: string;
  readbackVerified: true;
}

export interface EffectiveUserJournalPageData {
  pageId: string;
  name: string | null;
  type: string | null;
  textFormat: number | null;
  content: string;
  truncated: boolean;
}

export interface EffectiveUserJournalData {
  kind: "journalContent";
  journalEntryId: string;
  name: string | null;
  pages: EffectiveUserJournalPageData[];
}

export interface EffectiveUserTokenData {
  kind: "sceneToken";
  sceneId: string;
  tokenId: string;
  name: string | null;
  actorId: string | null;
  canObserve: true;
  canControl: boolean;
  hidden: boolean;
  position: { x: number; y: number; elevation: number };
  vision: {
    enabled: boolean;
    range: number | null;
    angle: number | null;
    mode: string | null;
  };
}

export interface EffectiveUserNoteData {
  kind: "noteAccess";
  sceneId: string;
  noteId: string;
  journalEntryId: string | null;
  pageId: string | null;
  canObserve: true;
  hidden: boolean;
  position: { x: number; y: number };
}

export type EffectiveUserOperationData =
  | EffectiveUserActorControlData
  | EffectiveUserActorOwnerProbeData
  | EffectiveUserJournalData
  | EffectiveUserTokenData
  | EffectiveUserNoteData;

/** Player-side result. The server adds the negotiated executing client. */
export interface EffectiveUserCommandResult {
  effectiveUserId: string;
  operation: EffectiveUserOperation["kind"];
  permissionDecision: {
    allowed: true;
    requiredPermission: "OBSERVER" | "OWNER";
  };
  mutationIds: string[];
  data: EffectiveUserOperationData;
}

export interface EffectiveUserExecutionResult extends EffectiveUserCommandResult {
  requestingUserId: string;
  executingClient: {
    clientId: string;
    lane: "player";
    foundryVersion: string;
    systemId: string;
    systemVersion: string;
    moduleVersion: string;
  };
  auditCorrelationId: string;
}
