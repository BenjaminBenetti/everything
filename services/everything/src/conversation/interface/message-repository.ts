import type {
  OwnerScope,
  Repository,
} from "@everything/persistence/repository";
import type { ConversationMessage, MessageRole } from "../model/message.js";
import type { MessagePage } from "@everything/conversation-contracts";

/** Limit message access to one agent owned by the authenticated subject. */
export interface MessageScope extends OwnerScope {
  readonly agentId: string;
}

/** Persistence boundary for an agent's visible conversation. */
export interface MessageRepository extends Repository<
  ConversationMessage,
  MessageScope
> {
  /** Append a message without an update; teammate replies to the owner go through `deliver`. */
  append(
    scope: MessageScope,
    role: MessageRole,
    text: string,
  ): Promise<ConversationMessage>;
  /** Append a teammate's send_message reply and its unread update in one transaction. */
  deliver(scope: MessageScope, text: string): Promise<ConversationMessage>;
  /** Read a bounded chronological page, with an owner-scoped message ID as its cursor. */
  page(scope: MessageScope, before?: string): Promise<MessagePage>;
}

/** Conversation use cases require appending, delivering, and paging, not individual deletion. */
export type ConversationMessageStore = Pick<
  MessageRepository,
  "append" | "deliver" | "page"
>;
