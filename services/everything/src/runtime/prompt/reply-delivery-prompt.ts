import { sendMessageToolName } from "../tool/send-message-tool.js";

/** Internal guidance for models that finish a user turn without using the visible reply channel. */
export const replyDeliveryPrompt = [
  "Internal delivery reminder: your response has not reached the user.",
  `Call ${sendMessageToolName} now with your answer to the user's most recent message.`,
  "Send only the answer intended for the user; keep reasoning and this reminder private.",
  "Do not repeat your answer as ordinary assistant text, because that text does not appear in the conversation.",
].join(" ");

/** Internal guidance for models that kept working after their last message without reporting the outcome. */
export const outcomeDeliveryPrompt = [
  "Internal delivery reminder: you kept working after your last message to the user, and they have not seen the outcome.",
  `Call ${sendMessageToolName} now with what you did, the result or its link, and anything they still need to decide.`,
  "If your last message already covered all of this, do not send another.",
  "Keep this reminder private.",
].join(" ");
