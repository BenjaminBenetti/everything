import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { messageTextMaxLength } from "../../conversation/model/message.js";
import type { MessageDelivery } from "../interface/agent-session.js";

/** Tool name the agent calls to reach the user; shared by the prompt and the tool allowlist. */
export const sendMessageToolName = "send_message";

/** Create the agent's only channel to the user: a deliberate, persisted conversation message. */
export function sendMessageTool(deliver: MessageDelivery) {
  return defineTool({
    name: sendMessageToolName,
    label: "Send message",
    description: "Send a deliberate, user-visible message to the conversation.",
    parameters: Type.Object(
      {
        text: Type.String({ minLength: 1, maxLength: messageTextMaxLength }),
      },
      { additionalProperties: false },
    ),
    /** Commit the visible reply before confirming delivery to Pi. */
    async execute(_id, parameters, signal) {
      signal?.throwIfAborted();
      await deliver(parameters.text);
      return {
        content: [{ type: "text", text: "Message delivered." }],
        details: {},
      };
    },
  });
}
