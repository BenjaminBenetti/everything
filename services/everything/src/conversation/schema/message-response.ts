import { Type } from "typebox";
import { messagePageSize } from "@everything/conversation-contracts";

/** IDs can be native transcript cursors or visible message UUIDs. */
export const chatMessageResponse = Type.Object({
  id: Type.String(),
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  text: Type.String(),
  createdAt: Type.String(),
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
  compacting: Type.Boolean(),
  typing: Type.Boolean(),
  backgroundCount: Type.Integer({ minimum: 0 }),
  sessionId: Type.Union([Type.String(), Type.Null()]),
  runId: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
});
