import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { messageTextMaxLength } from "../../conversation/model/message.js";
import type { MessageDelivery } from "../interface/agent-session.js";

/** Tool name the agent calls to reach the user; shared by the prompt and the tool allowlist. */
export const sendMessageToolName = "send_message";

/** Create the teammate's user-visible delivery tool and advertise the chat's Markdown support. */
export function sendMessageTool(deliver: MessageDelivery) {
  return defineTool({
    name: sendMessageToolName,
    label: "Send message",
    description:
      "Send a deliberate, user-visible message to the conversation. Markdown is supported, including headings, bold and italic text, lists, links, blockquotes, fenced code blocks, and tables. Raw HTML is displayed as text.",
    parameters: Type.Object(
      {
        text: Type.String({
          description:
            "The message to show the user, as Markdown or plain text.",
          minLength: 1,
          maxLength: messageTextMaxLength,
        }),
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
