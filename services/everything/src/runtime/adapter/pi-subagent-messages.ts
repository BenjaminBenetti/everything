import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  messagePageSize,
  type ChatMessage,
  type MessagePage,
} from "@everything/conversation-contracts";
import { forkToolNames } from "../model/fork-policy.js";
import { sendMessageToolName } from "../model/message-delivery.js";

/** Project conversational text and successful explicit messages, never thinking, tools, or provider errors. */
export function piSubagentMessages(
  entries: readonly SessionEntry[],
  before?: string,
): MessagePage {
  const succeeded = new Set(
    entries.flatMap((entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      !entry.message.isError
        ? [entry.message.toolCallId]
        : [],
    ),
  );
  const messages: ChatMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.role === "assistant" && message.stopReason === "error")
      continue;
    const parts: string[] = [];
    if (typeof message.content === "string") parts.push(message.content);
    else
      for (const block of message.content) {
        if (block.type === "text") parts.push(block.text);
        else if (
          block.type === "toolCall" &&
          succeeded.has(block.id) &&
          [sendMessageToolName, forkToolNames.send].includes(block.name) &&
          typeof block.arguments?.text === "string"
        )
          parts.push(block.arguments.text);
      }
    const text = parts.filter(Boolean).join("\n\n");
    if (text)
      messages.push({
        id: entry.id,
        role: message.role,
        text,
        createdAt: entry.timestamp,
        attachments: [],
      });
  }
  const end =
    before === undefined
      ? messages.length
      : messages.findIndex((message) => message.id === before);
  if (end < 0) return { messages: [], nextCursor: null };
  const start = Math.max(0, end - messagePageSize);
  const page = messages.slice(start, end);
  return { messages: page, nextCursor: start > 0 ? page[0]!.id : null };
}
