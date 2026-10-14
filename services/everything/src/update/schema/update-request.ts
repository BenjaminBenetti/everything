import { Type, type Static } from "typebox";
import { readReceiptMaxSize } from "@everything/conversation-contracts";

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
