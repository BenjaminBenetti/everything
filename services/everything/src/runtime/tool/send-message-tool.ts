import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { messageTextMaxLength } from "../../conversation/model/message.js";
import type { MessageDelivery } from "../interface/agent-session.js";
import { sendMessageToolName } from "../model/message-delivery.js";
export { sendMessageToolName } from "../model/message-delivery.js";

/** Bind explicit delivery to the user for the main session or privately to a fork's parent. */
export function sendMessageTool(
  deliver: MessageDelivery,
  privateReply = false,
) {
  return defineTool({
    name: sendMessageToolName,
    label: "Send message",
    description: privateReply
      ? "Send a private message to the session that forked you. Use this for progress, questions, and results. Your parent decides what to share with the user."
      : "Send a deliberate, user-visible message to the conversation. Markdown is supported, including headings, bold and italic text, lists, links, blockquotes, fenced code blocks, and tables. Raw HTML is displayed as text. To display a PNG, JPEG, GIF, or WebP in your own workspace, use an explicit image: ![Chart](plots/chart.png), relative to your workspace root, or an absolute path inside your own workspace. Hidden files/folders and links are unavailable. Bare paths and ordinary links do not display images. References show the current file; moving, deleting or replacing it affects old messages, so use versioned filenames for lasting history.",
    parameters: Type.Object(
      {
        text: Type.String({
          description: privateReply
            ? "The private message to send to your parent."
            : "The message to show the user, as Markdown or plain text.",
          minLength: 1,
          maxLength: messageTextMaxLength,
        }),
      },
      { additionalProperties: false },
    ),
    /** Commit the user reply or queue the private reply before confirming delivery to Pi. */
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
