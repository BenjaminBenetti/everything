import { Type } from "typebox";
import { updatePageSize } from "@everything/update-contracts";

/** Unread or previously seen message updates, newest first, with an opaque paging cursor. */
export const updatePageResponse = Type.Object({
  updates: Type.Array(
    Type.Object({
      id: Type.String(),
      kind: Type.Literal("message"),
      summary: Type.String(),
      summaryStatus: Type.Union(
        ["pending", "ready", "unavailable", "disabled"].map((value) =>
          Type.Literal(value),
        ),
      ),
      createdAt: Type.String(),
      agentId: Type.String(),
      messageId: Type.String(),
    }),
    { maxItems: updatePageSize },
  ),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

/** Unread totals, with per-teammate counts keyed by teammate ID. */
export const updateCountResponse = Type.Object({
  unread: Type.Integer({ minimum: 0 }),
  byAgent: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
});
