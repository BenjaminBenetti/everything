import { sendMessageToolName } from "../tool/send-message-tool.js";

/** Internal guidance for models that finish a user turn without using the visible reply channel. */
export const replyDeliveryPrompt = [
  "Internal delivery reminder: your response has not reached the user.",
  `Call ${sendMessageToolName} now with your answer to the user's most recent message.`,
  "Send only the answer intended for the user; keep reasoning and this reminder private.",
  "Do not repeat your answer as ordinary assistant text, because that text does not appear in the conversation.",
].join(" ");
