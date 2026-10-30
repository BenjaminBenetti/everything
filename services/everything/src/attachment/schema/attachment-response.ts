import { Type } from "typebox";
import { attachmentLimits } from "../model/attachment.js";

const attachmentKind = Type.Union(
  [Type.Literal("image"), Type.Literal("text"), Type.Literal("binary")],
  {
    description:
      "What the server found the file to be from its bytes: a PNG, JPEG, GIF, or WebP image; UTF-8 text; or anything else.",
  },
);

/** A file attached to a sent message: its workspace path and small facts, never its contents. */
export const messageAttachmentResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String({
    description: "The file's name as the user chose it, for display only.",
  }),
  size: Type.Integer({ minimum: 0 }),
  kind: attachmentKind,
  mediaType: Type.String(),
  path: Type.String({
    description:
      "Server-chosen absolute path of the file in the teammate's workspace.",
  }),
});

/** An upload in progress or waiting to be sent. */
export const attachmentUploadResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  size: Type.Integer({ minimum: 0 }),
  received: Type.Integer({
    minimum: 0,
    description: "Bytes saved so far; the next part starts here.",
  }),
  status: Type.Union([Type.Literal("uploading"), Type.Literal("ready")]),
  kind: Type.Union([attachmentKind, Type.Null()]),
  mediaType: Type.Union([Type.String(), Type.Null()]),
  path: Type.String({
    description:
      "Where the file will be in the teammate's workspace once it is ready.",
  }),
});

/** The teammate's unsent attachments. */
export const attachmentUploadListResponse = Type.Object({
  attachments: Type.Array(attachmentUploadResponse, {
    maxItems: attachmentLimits.maxFiles,
  }),
});

/** File bytes; images display inline and every other file downloads. */
export const attachmentContentResponse = Type.String({
  format: "binary",
  description:
    "The file as it is now in the teammate's workspace. PNG, JPEG, GIF, and WebP images are sent with their media type for display; every other file is sent as application/octet-stream to download.",
});
