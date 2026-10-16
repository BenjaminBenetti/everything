import type { MessageRepository, MessageScope } from "./message-repository.js";
import type { ConversationSearchInput } from "../schema/conversation-search.js";
import type { ConversationSearchResult } from "../model/conversation-search.js";

/** Only the scoped reads needed to recover visible conversation history. */
export type ConversationSearchStore = Pick<
  MessageRepository,
  "search" | "neighbors"
>;

/** Search policy shared by main sessions and their private background sessions. */
export interface ConversationSearchReader {
  /** Find bounded excerpts in the specified owner's single teammate conversation. */
  search(
    scope: MessageScope,
    input: ConversationSearchInput,
    signal?: AbortSignal,
  ): Promise<ConversationSearchResult>;
}
