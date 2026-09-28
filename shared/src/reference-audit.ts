export const REFERENCE_AUDIT_COMMAND = "references.audit";
export type ReferenceAuditClass =
  | "uuid"
  | "asset"
  | "embedded"
  | "note"
  | "tokenActor"
  | "folder"
  | "ownership"
  | "stableId"
  | "tableResult";
export interface ReferenceAuditInput {
  includeDocumentTypes?: string[];
  maxDocuments?: number;
  maxIssues?: number;
}
export interface ReferenceAuditIssue {
  class: ReferenceAuditClass;
  code: string;
  documentUuid?: string;
  fieldPath?: string;
  target?: string;
  message: string;
}
export interface ReferenceAuditClassResult {
  class: ReferenceAuditClass;
  complete: boolean;
  scanned: number;
  issueCount: number;
  reason?: string;
}
export interface ReferenceAuditResult {
  clean: boolean | null;
  complete: boolean;
  scannedDocuments: number;
  classes: ReferenceAuditClassResult[];
  issues: ReferenceAuditIssue[];
  truncated: boolean;
}
