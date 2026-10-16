import type { ConversationSearchReader } from "../../conversation/interface/conversation-search.js";

/** Unrelated runtime tests expose conversation search without a database. */
export const testConversationSearch: ConversationSearchReader = {
  /** Return an empty history for tests that do not seed visible messages. */
  search: async (_scope, input) => ({
    query: input.query,
    matches: [],
    nextCursor: null,
  }),
};
