import { Type, type Static } from "typebox";
import { attachmentLimits } from "@everything/conversation-contracts/attachment";
import { nonBlankText } from "../../http/schema/text-schema.js";
import { messageTextMaxLength } from "../model/message.js";

/** Files uploaded for the message, named by the IDs their uploads returned. */
function attachmentIds(minItems: number) {
  return Type.Array(Type.String({ format: "uuid" }), {
    minItems,
    maxItems: attachmentLimits.maxFiles,
    uniqueItems: true,
    description:
      "Unsent, fully uploaded attachments of this teammate, in the order to show them. The teammate receives their workspace paths, not their contents.",
  });
}

/**
 * Request body for a user message sent to an agent: non-blank text, at least one attached file, or
 * both. Text-only bodies are unchanged from before attachments existed. The server checks each
 * attachment again when the message is saved.
 */
export const sendMessageBody = Type.Union([
  Type.Object(
    {
      text: nonBlankText(messageTextMaxLength),
      attachmentIds: Type.Optional(attachmentIds(0)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      text: Type.Optional(
        Type.String({
          maxLength: messageTextMaxLength,
          description: "May be omitted or blank when files are attached.",
        }),
      ),
      attachmentIds: attachmentIds(1),
    },
    { additionalProperties: false },
  ),
]);

/** Validated request body for a user message sent to an agent. */
export type SendMessageBody = Static<typeof sendMessageBody>;

/** Opaque message IDs bound the history query without accepting arbitrary offsets. */
export const messageHistoryQuery = Type.Object(
  { before: Type.Optional(Type.String({ format: "uuid" })) },
  { additionalProperties: false },
);
export type MessageHistoryQuery = Static<typeof messageHistoryQuery>;
