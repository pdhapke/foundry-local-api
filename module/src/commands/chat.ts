// Phase 14 — Chat Messages command handlers. Registered against the same
// command dispatcher registry Phase 2 set up (module/src/command-registry.ts)
// and imported for side effects from module/src/index.ts.
//
// `ChatMessage` is itself a regular Foundry document type, so both handlers
// reuse the same `game.collections`/`CONFIG` surface Phase 8 already added
// to foundry-globals.d.ts — no new ambient declarations needed. This is
// hand-rolled rather than routed through the Phase 8 generic document
// commands because listing is bounded ("recent log", via `limit`) rather
// than a raw full-collection dump.
import {
  CHAT_COMMANDS,
  type ChatListInput,
  type ChatMessageData,
  type ChatSendInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requireChatMessageCollection(): Map<string, FoundryDocument> {
  const collection = game.collections.get("ChatMessage");
  if (!collection) {
    throw new Error('Unknown document type "ChatMessage"');
  }
  return collection;
}

registerCommand(CHAT_COMMANDS.LIST, ({ limit }: ChatListInput): ChatMessageData[] => {
  const messages = Array.from(requireChatMessageCollection().values()).map((msg) => msg.toObject());
  return limit === undefined ? messages : messages.slice(-limit);
});

registerCommand(CHAT_COMMANDS.SEND, async ({ data }: ChatSendInput): Promise<ChatMessageData> => {
  const cls = CONFIG["ChatMessage"]?.documentClass;
  if (!cls) {
    throw new Error('Unknown document type "ChatMessage"');
  }
  const created = await cls.create(data);
  if (!created) {
    throw new Error("Failed to create ChatMessage");
  }
  return created.toObject();
});
