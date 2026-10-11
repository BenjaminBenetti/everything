import type {
  OwnerScope,
  Repository,
} from "@everything/persistence/repository";
import type { ConversationMessage, MessageRole } from "../model/message.js";

/** Limit message access to one agent owned by the authenticated subject. */
export interface MessageScope extends OwnerScope {
  readonly agentId: string;
}

/** Persistence boundary for an agent's visible conversation. */
export interface MessageRepository extends Repository<
  ConversationMessage,
  MessageScope
> {
  /** Append a user message or an explicit agent send_message tool result. */
  append(
    scope: MessageScope,
    role: MessageRole,
    text: string,
  ): Promise<ConversationMessage>;
  /** Return the latest messages in chronological order. */
  list(scope: MessageScope): Promise<ConversationMessage[]>;
}

/** Conversation use cases only require appending and listing, not individual deletion. */
export type ConversationMessageStore = Pick<
  MessageRepository,
  "append" | "list"
>;
