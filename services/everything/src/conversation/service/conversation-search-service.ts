import { Value } from "typebox/value";
import type {
  ConversationSearchReader,
  ConversationSearchStore,
} from "../interface/conversation-search.js";
import type { MessageScope } from "../interface/message-repository.js";
import type { ConversationMessage } from "../model/message.js";
import {
  conversationSearchContextLength,
  conversationSearchDefaultLimit,
  conversationSearchExcerptLength,
  type ConversationExcerpt,
  type ConversationSearchResult,
} from "../model/conversation-search.js";
import {
  conversationSearchSchema,
  type ConversationSearchInput,
} from "../schema/conversation-search.js";
import { ConversationSearchInputError } from "../error/conversation-search-errors.js";

/** Recover saved chat without loading an entire conversation into model context. */
export class ConversationSearchService implements ConversationSearchReader {
  // ===========================================
  // Construction
  // ===========================================

  /** Depend only on scoped history reads, independent of the runtime and model provider. */
  constructor(private readonly messages: ConversationSearchStore) {}

  // ===========================================
  // Search
  // ===========================================

  /** Apply bounds, preserve insertion pagination, and attach short neighboring excerpts. */
  async search(
    scope: MessageScope,
    input: ConversationSearchInput,
    signal?: AbortSignal,
  ): Promise<ConversationSearchResult> {
    signal?.throwIfAborted();
    if (!Value.Check(conversationSearchSchema, input))
      throw new ConversationSearchInputError();
    const query = input.query.trim();
    const page = await this.messages.search(scope, {
      ...input,
      query,
      limit: input.limit ?? conversationSearchDefaultLimit,
    });
    const matches = [];
    for (const message of page.messages) {
      signal?.throwIfAborted();
      const neighbors = await this.messages.neighbors(scope, message.id);
      matches.push({
        message: excerpt(message, conversationSearchExcerptLength, query),
        before: neighbors.before
          ? excerpt(neighbors.before, conversationSearchContextLength)
          : null,
        after: neighbors.after
          ? excerpt(neighbors.after, conversationSearchContextLength)
          : null,
      });
    }
    signal?.throwIfAborted();
    return { query, matches, nextCursor: page.nextCursor };
  }
}

/** Center a bounded excerpt on a literal match and mark omitted text explicitly; attachment paths stay whole. */
function excerpt(
  { id, role, text, createdAt, attachments }: ConversationMessage,
  maximum: number,
  query?: string,
): ConversationExcerpt {
  const match = query ? text.toLowerCase().indexOf(query.toLowerCase()) : 0;
  const start = Math.min(
    Math.max(0, text.length - maximum),
    Math.max(0, match - Math.floor(maximum / 3)),
  );
  const end = Math.min(text.length, start + maximum);
  return {
    id,
    role,
    createdAt,
    attachments,
    excerpt: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    truncated: start > 0 || end < text.length,
  };
}
