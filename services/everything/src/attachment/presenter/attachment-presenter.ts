import type {
  Attachment,
  AttachmentUpload,
  MessageAttachment,
} from "../model/attachment.js";

/** Show an upload's progress without its message relation or timestamps. */
export function representUpload(attachment: Attachment): AttachmentUpload {
  const { id, name, size, received, status, kind, mediaType, path } =
    attachment;
  return { id, name, size, received, status, kind, mediaType, path };
}

/** Show a sent attachment as the small reference a message carries. */
export function representMessageAttachment(
  attachment: Pick<
    Attachment,
    "id" | "name" | "size" | "kind" | "mediaType" | "path"
  >,
): MessageAttachment {
  const { id, name, size, kind, mediaType, path } = attachment;
  if (!kind || !mediaType)
    throw new Error("Only complete attachments belong to a message");
  return { id, name, size, kind, mediaType, path };
}
