import { Type, type Static } from "typebox";
import {
  conversationSearchDefaultLimit,
  conversationSearchMaxLimit,
  conversationSearchQueryMaxLength,
} from "../model/conversation-search.js";

/** Read-only search inputs; the harness supplies ownership and teammate identity. */
export const conversationSearchSchema = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: conversationSearchQueryMaxLength,
      pattern: "\\S",
      description:
        "Literal text or phrase to find, ignoring case. Leading and trailing whitespace is trimmed. No wildcards, regular expressions, or semantic matching.",
    }),
    role: Type.Optional(
      Type.Union([Type.Literal("user"), Type.Literal("assistant")], {
        description:
          "Filter matches to the user's messages or the teammate's visible replies.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: conversationSearchMaxLimit,
        default: conversationSearchDefaultLimit,
        description: "Maximum number of matching messages, newest first.",
      }),
    ),
    before: Type.Optional(
      Type.String({
        pattern:
          "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        description:
          "Use nextCursor from a previous result to find older matches with the same query and role.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type ConversationSearchInput = Static<typeof conversationSearchSchema>;
