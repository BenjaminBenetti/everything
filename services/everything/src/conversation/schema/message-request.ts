import { Type, type Static } from "typebox";
import { nonBlankText } from "../../http/schema/text-schema.js";
import { messageTextMaxLength } from "../model/message.js";

/** Request body for a user message sent to an agent. */
export const sendMessageBody = Type.Object(
  { text: nonBlankText(messageTextMaxLength) },
  { additionalProperties: false },
);

/** Validated request body for a user message sent to an agent. */
export type SendMessageBody = Static<typeof sendMessageBody>;
