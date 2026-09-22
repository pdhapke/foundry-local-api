// Phase 14 — Chat Messages.
//
// Both descriptors share the `/chat` route (GET lists, POST sends), mirroring
// how the Phase 8 factory pairs list/create on one route base — but hand-
// rolled here since only these two operations are called for (see
// shared/src/chat.ts's header comment for why this doesn't run the generic
// factory against `ChatMessage`).
import { z } from "zod";

import {
  CHAT_COMMANDS,
  type ChatListInput,
  type ChatMessageData,
  type ChatSendInput,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const listChatSchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
});

const sendChatSchema = z.object({
  data: z.record(z.string(), z.unknown()),
});

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

export const chatEndpointDescriptors: AnyEndpointDescriptor[] = [
  listChatDescriptor,
  sendChatDescriptor,
];
