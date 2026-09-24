// Phase 14 — Chat Messages.
//
// List/send share the `/chat` route (GET lists, POST sends), mirroring how
// the Phase 8 factory pairs list/create on one route base — but hand-rolled
// here since only these two operations were originally called for (see
// shared/src/chat.ts's header comment for why this doesn't run the generic
// factory against `ChatMessage`).
//
// Phase 45 added update/delete of a single message under `/chat/:id`. These
// call Phase 8's already-generic `DOCUMENT_COMMANDS.UPDATE`/`DELETE` with
// `documentType: "ChatMessage"` baked in directly, the same commands every
// `makeDocumentEndpoints()` caller uses — not the factory itself, since the
// factory would also regenerate list/create descriptors colliding with the
// hand-rolled `/chat` route above (different request/response shapes at the
// same path).
import { z } from "zod";

import {
  CHAT_COMMANDS,
  DOCUMENT_COMMANDS,
  type ChatListInput,
  type ChatMessageData,
  type ChatSendInput,
  type DocumentData,
  type DocumentDeleteResult,
  type DocumentIdInput,
  type DocumentUpdateInput,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const listChatSchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
});

const sendChatSchema = z.object({
  data: z.record(z.string(), z.unknown()),
});

const chatIdSchema = z.object({ id: z.string().min(1) });
const updateChatSchema = chatIdSchema.extend({ changes: z.record(z.string(), z.unknown()) });

const listChatDescriptor: EndpointDescriptor<ChatListInput, ChatMessageData[]> = {
  name: "foundry_list_chat_messages",
  description: "Lists recent chat log messages, oldest first. Optionally capped by `limit`.",
  method: "get",
  path: "/chat",
  inputSchema: listChatSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<ChatListInput, ChatMessageData[]>(CHAT_COMMANDS.LIST, input),
};

const sendChatDescriptor: EndpointDescriptor<ChatSendInput, ChatMessageData> = {
  name: "foundry_send_chat_message",
  description: 'Posts a new message to the chat log (e.g. { "content": "Hello!" }).',
  method: "post",
  path: "/chat",
  inputSchema: sendChatSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<ChatSendInput, ChatMessageData>(CHAT_COMMANDS.SEND, input),
};

const updateChatDescriptor: EndpointDescriptor<
  { id: string; changes: Record<string, unknown> },
  DocumentData
> = {
  name: "foundry_update_chat_message",
  description: "Updates fields on an existing chat message.",
  method: "put",
  path: "/chat/:id",
  inputSchema: updateChatSchema,
  handler: ({ id, changes }, { foundryClient }) =>
    foundryClient.call<DocumentUpdateInput, DocumentData>(DOCUMENT_COMMANDS.UPDATE, {
      documentType: "ChatMessage",
      id,
      changes,
    }),
};

const deleteChatDescriptor: EndpointDescriptor<{ id: string }, DocumentDeleteResult> = {
  name: "foundry_delete_chat_message",
  description: "Deletes a chat message by id.",
  method: "delete",
  path: "/chat/:id",
  inputSchema: chatIdSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<DocumentIdInput, DocumentDeleteResult>(DOCUMENT_COMMANDS.DELETE, {
      documentType: "ChatMessage",
      id,
    }),
};

export const chatEndpointDescriptors: AnyEndpointDescriptor[] = [
  listChatDescriptor,
  sendChatDescriptor,
  updateChatDescriptor,
  deleteChatDescriptor,
];
