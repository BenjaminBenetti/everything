import type { BaseEntity } from "@everything/persistence/entity";
import type { ChatMessage } from "@everything/conversation-contracts";
export {
  messageTextMaxLength,
  type MessageReceipt,
  type MessagePage,
} from "@everything/conversation-contracts";

/** Author of a visible message: the user, or the agent through its send_message tool. */
export type MessageRole = ChatMessage["role"];

/** A message visible in the user's conversation with an agent. */
export interface ConversationMessage extends BaseEntity, ChatMessage {}
