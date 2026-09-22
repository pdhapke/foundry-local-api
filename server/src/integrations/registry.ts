// Phase 32 — the explicit, audit-friendly list of every known integration.
//
// Deliberately a plain array populated by hand, not auto-discovery (e.g.
// scanning subdirectories) — PLAN.md's Phase 32 spec calls for "one explicit
// list ... so the active set is easy to audit." Later phases (33+, starting
// with Phase 34's dnd5e integration) append entries here.
import type { Integration } from "./types.js";

export const integrations: Integration[] = [];
