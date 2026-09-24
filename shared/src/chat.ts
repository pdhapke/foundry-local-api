// Phase 14 — Chat Messages. Unlike world-level document types (JournalEntry,
// Actor, Item, Scene), chat only needs create + a bounded "recent log" read
// per PLAN.md's Phase 14 text — no get/update/delete of an individual
// message is called for — so this hand-rolls two commands rather than
// running the Phase 8 generic factory against `ChatMessage`. Shared between
// the server's chat endpoints (server/src/endpoints/chat.ts) and the
// module's chat command handlers (module/src/commands/chat.ts).
//
// Phase 45 added update/delete of a single message. These reuse Phase 8's
// generic `DOCUMENT_COMMANDS.UPDATE`/`DELETE` with `documentType:
// "ChatMessage"` directly (see server/src/endpoints/chat.ts) rather than
// adding new commands here — the module-side handlers already registered
// for Phase 8 are fully generic across document types and need no
// ChatMessage-specific code. Only list/create were ever narrowed; update/
// delete were simply never wired up to a route.

export const CHAT_COMMANDS = {
  LIST: "chatList",
  SEND: "chatSend",
} as const;

export interface ChatListInput {
  /** Caps the result to the most recent N messages (oldest first). Omit for the full log. */
  limit?: number | undefined;
}

export interface ChatSendInput {
  data: Record<string, unknown>;
}

/** A chat message's plain data, as returned by Foundry's `ChatMessage#toObject()`. */
export type ChatMessageData = Record<string, unknown>;
