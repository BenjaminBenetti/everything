import { Type } from "typebox";
import { messagePageSize } from "@everything/conversation-contracts";
import { messageAttachmentResponse } from "../../attachment/schema/attachment-response.js";

/** IDs can be native transcript cursors or visible message UUIDs. */
export const chatMessageResponse = Type.Object({
  id: Type.String(),
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  text: Type.String({
    description: "Empty for a user message that carries only attachments.",
  }),
  createdAt: Type.String(),
  attachments: Type.Array(messageAttachmentResponse, {
    description:
      "Files sent with the message, in the order they were attached.",
  }),
});

/** Chronological messages and an opaque cursor for the preceding page. */
export const messagePageResponse = Type.Object({
  messages: Type.Array(chatMessageResponse, { maxItems: messagePageSize }),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

/** A saved main-conversation message and the asynchronous run it started. */
export const messageReceiptResponse = Type.Object({
  messageId: Type.String(),
  runId: Type.String(),
});

/** Safe state of the ongoing conversation and its private background work. */
export const runtimeStatusResponse = Type.Object({
  status: Type.Union([
    Type.Literal("idle"),
    Type.Literal("running"),
    Type.Literal("error"),
  ]),
  mainRunning: Type.Boolean({
    description:
      "Whether the main conversation itself is working, including model and tool calls. Background teammates count only toward status and backgroundCount.",
  }),
  compacting: Type.Boolean(),
  compactionStartedAt: Type.Union(
    [Type.String({ format: "date-time" }), Type.Null()],
    {
      description:
        "When the active compaction began; null when no compaction is running.",
    },
  ),
  typing: Type.Boolean(),
  backgroundCount: Type.Integer({ minimum: 0 }),
  monitorCount: Type.Integer({
    minimum: 0,
    description:
      "Monitors the teammate or its background teammates started whose commands are still running. Only the count is reported.",
  }),
  sessionId: Type.Union([Type.String(), Type.Null()]),
  runId: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
});
