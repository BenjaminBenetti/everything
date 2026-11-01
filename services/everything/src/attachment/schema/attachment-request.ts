import { Type, type Static } from "typebox";
import { nonBlankText } from "../../http/schema/text-schema.js";
import { attachmentLimits } from "../model/attachment.js";

/** Route parameters identifying one attachment of one teammate. */
export const attachmentParams = Type.Object(
  {
    agentId: Type.String({ format: "uuid" }),
    attachmentId: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);
export type AttachmentParams = Static<typeof attachmentParams>;

/**
 * Begin an upload with the file's name and exact size. The browser's media type and any path are
 * not accepted: the server decides where the file goes and tells what it is from its bytes.
 */
export const createAttachmentBody = Type.Object(
  {
    name: nonBlankText(attachmentLimits.nameLength),
    size: Type.Integer({ minimum: 0, maximum: attachmentLimits.maxFileBytes }),
  },
  { additionalProperties: false },
);
export type CreateAttachmentBody = Static<typeof createAttachmentBody>;

/** Byte position where an uploaded part begins; query values are strings, so digits are matched. */
export const attachmentPartQuery = Type.Object(
  {
    offset: Type.String({
      pattern: "^(?:0|[1-9][0-9]{0,8})$",
      description:
        "Where this part begins: the upload's received count, which starts at 0.",
    }),
  },
  { additionalProperties: false },
);
export type AttachmentPartQuery = Static<typeof attachmentPartQuery>;
