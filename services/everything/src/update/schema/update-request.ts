import { Type, type Static } from "typebox";
import { readReceiptMaxSize } from "@everything/conversation-contracts";

/** Page the feed by an owner-scoped update ID rather than arbitrary offsets. */
export const updateFeedQuery = Type.Object(
  { before: Type.Optional(Type.String({ format: "uuid" })) },
  { additionalProperties: false },
);
export type UpdateFeedQuery = Static<typeof updateFeedQuery>;

/** Bound acknowledgement batches and reject client-supplied timestamps or ownership. */
export const readMessagesBody = Type.Object(
  {
    messageIds: Type.Array(Type.String({ format: "uuid" }), {
      minItems: 1,
      maxItems: readReceiptMaxSize,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type ReadMessagesBody = Static<typeof readMessagesBody>;
