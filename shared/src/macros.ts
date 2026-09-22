// Phase 15 — Macros. Command name and payload/result shape for the one
// macro-specific extra layered on top of the Phase 8 generic document CRUD
// (Macro CRUD itself reuses DOCUMENT_COMMANDS with documentType: "Macro",
// identical to Scene/Actor/Item), shared between the server's macro
// endpoints (server/src/endpoints/macros.ts) and the module's macro command
// handlers (module/src/commands/macros.ts).

export const MACRO_COMMANDS = {
  EXECUTE: "macroExecute",
} as const;

export interface MacroIdInput {
  id: string;
}

export interface MacroExecuteResult {
  id: string;
  executed: true;
}
