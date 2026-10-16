import type { ConversationMessage } from "./message.js";

export const conversationSearchToolName = "conversation_search";
export const conversationSearchQueryMaxLength = 200;
export const conversationSearchDefaultLimit = 5;
export const conversationSearchMaxLimit = 10;
export const conversationSearchExcerptLength = 1500;
export const conversationSearchContextLength = 500;

/** A bounded excerpt with the original message's identity and timestamp. */
export interface ConversationExcerpt extends Omit<ConversationMessage, "text"> {
  readonly excerpt: string;
  readonly truncated: boolean;
}

/** A matching message and the immediately adjacent visible messages. */
export interface ConversationSearchMatch {
  readonly message: ConversationExcerpt;
  readonly before: ConversationExcerpt | null;
  readonly after: ConversationExcerpt | null;
}

/** Newest matches first, with a stable insertion cursor for older matches. */
export interface ConversationSearchResult {
  readonly query: string;
  readonly matches: readonly ConversationSearchMatch[];
  readonly nextCursor: string | null;
}
