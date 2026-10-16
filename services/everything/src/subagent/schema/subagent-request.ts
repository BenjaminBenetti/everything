import { Type, type Static } from "typebox";
import { subagentCursorMaxLength } from "@everything/agent-contracts/subagent";
import { messageTextMaxLength } from "@everything/conversation-contracts";
import { nonBlankText } from "../../http/schema/text-schema.js";

/** A background UUID belongs to exactly one saved teammate's family. */
export const subagentParams = Type.Object(
  {
    agentId: Type.String({ format: "uuid" }),
    subagentId: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);
export type SubagentParams = Static<typeof subagentParams>;

/** Start fresh by default; callers may explicitly copy the main teammate's context. */
export const createSubagentBody = Type.Object(
  {
    task: nonBlankText(messageTextMaxLength),
    context: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type CreateSubagentBody = Static<typeof createSubagentBody>;

/** Page native transcript messages using opaque IDs rather than filesystem locations. */
export const subagentHistoryQuery = Type.Object(
  {
    before: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: subagentCursorMaxLength,
        pattern: "^[a-zA-Z0-9_-]+$",
      }),
    ),
  },
  { additionalProperties: false },
);
export type SubagentHistoryQuery = Static<typeof subagentHistoryQuery>;
