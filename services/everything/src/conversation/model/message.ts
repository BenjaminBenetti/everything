import type { BaseEntity } from "@everything/persistence/entity";

/** Inclusive maximum length of a visible message, shared by the API, database, and agent tool. */
export const messageTextMaxLength = 32000;

/** Author of a visible message: the user, or the agent through its send_message tool. */
export type MessageRole = "user" | "assistant";

/** A message visible in the user's conversation with an agent. */
export interface ConversationMessage extends BaseEntity {
  readonly role: MessageRole;
  readonly text: string;
}

/** Identifiers returned once a user message is saved and its agent turn has started. */
export interface MessageReceipt {
  readonly messageId: string;
  readonly runId: string;
}
