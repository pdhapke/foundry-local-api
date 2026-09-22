// Phase 15 — Macros.
//
// Base CRUD reuses the Phase 8 `makeDocumentEndpoints()` factory with
// `documentType: "Macro"`, same as JournalEntry/Actor/Item/Scene. The one
// extra PLAN.md's Phase 15 calls for (execute) is hand-rolled here, since
// it's macro-specific, not generic document behavior — see
// module/src/commands/macros.ts for the matching module-side handler.
//
// Execution runs whatever script/chat command is stored on the macro with
// full Foundry client privileges (a "script"-type macro is arbitrary
// JavaScript, evaluated the same way Foundry's own macro bar runs it) — see
// the `annotations`/description below for the explicit safety flag PLAN.md's
// Phase 15 calls for.
import { z } from "zod";

import {
  MACRO_COMMANDS,
  type MacroExecuteResult,
  type MacroIdInput,
} from "@foundry-local-api/shared";

import { makeDocumentEndpoints } from "./documents.js";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const idSchema = z.object({ id: z.string().min(1) });

const executeDescriptor: EndpointDescriptor<MacroIdInput, MacroExecuteResult> = {
  name: "foundry_execute_macro",
  description:
    "Executes a macro by id, running its stored script or chat command with full Foundry client " +
    "privileges. WARNING: a script-type macro is arbitrary JavaScript — only execute macros you " +
    "trust, exactly as if you were clicking them on the macro bar yourself.",
  method: "post",
  path: "/macros/:id/execute",
  inputSchema: idSchema,
  annotations: {
    title: "Execute Macro (runs arbitrary JavaScript)",
    destructiveHint: true,
    openWorldHint: true,
  },
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<MacroIdInput, MacroExecuteResult>(MACRO_COMMANDS.EXECUTE, { id }),
};

export const macroEndpointDescriptors: AnyEndpointDescriptor[] = [
  ...makeDocumentEndpoints({
    documentType: "Macro",
    routeBase: "macros",
    toolSingular: "macro",
    toolPlural: "macros",
  }),
  executeDescriptor,
];
