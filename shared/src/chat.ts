// Phase 14 — Chat Messages. Unlike world-level document types (JournalEntry,
// Actor, Item, Scene), chat only needs create + a bounded "recent log" read
// per PLAN.md's Phase 14 text — no get/update/delete of an individual
// message is called for — so this hand-rolls two commands rather than
// running the Phase 8 generic factory against `ChatMessage`. Shared between
// the server's chat endpoints (server/src/endpoints/chat.ts) and the
// module's chat command handlers (module/src/commands/chat.ts).

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
