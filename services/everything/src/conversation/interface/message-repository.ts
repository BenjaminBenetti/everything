import type {
  OwnerScope,
  Repository,
} from "@everything/persistence/repository";
import type { ConversationMessage, MessageRole } from "../model/message.js";
import type { MessagePage } from "@everything/conversation-contracts";
import type { ConversationSearchInput } from "../schema/conversation-search.js";

/** Limit message access to one agent owned by the authenticated subject. */
export interface MessageScope extends OwnerScope {
  readonly agentId: string;
}

/** Persistence boundary for an agent's visible conversation. */
export interface MessageRepository extends Repository<
  ConversationMessage,
  MessageScope
> {
  /**
   * Append a message without an update, claiming the named unsent attachments of the same teammate
   * atomically; teammate replies to the owner go through `deliver`.
   */
  append(
    scope: MessageScope,
    role: MessageRole,
    text: string,
    attachmentIds?: readonly string[],
  ): Promise<ConversationMessage>;
  /** Append a teammate's send_message reply and its unread update in one transaction. */
  deliver(scope: MessageScope, text: string): Promise<ConversationMessage>;
  /** Read a bounded chronological page, with an owner-scoped message ID as its cursor. */
  page(scope: MessageScope, before?: string): Promise<MessagePage>;
  /** Find literal text matches in insertion order, with a scoped cursor and explicit bound. */
  search(
    scope: MessageScope,
    input: ConversationSearchInput & { readonly limit: number },
  ): Promise<MessagePage>;
  /** Read the closest visible messages on either side of an owned message. */
  neighbors(
    scope: MessageScope,
    id: string,
  ): Promise<{
    before: ConversationMessage | null;
    after: ConversationMessage | null;
  }>;
}

/** Conversation use cases require appending, delivering, and paging, not individual deletion. */
export type ConversationMessageStore = Pick<
  MessageRepository,
  "append" | "deliver" | "page"
>;
