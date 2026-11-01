import { ApplicationError } from "@everything/errors";
import { attachmentLimits } from "../model/attachment.js";

/** Missing attachments and attachments of another owner or teammate look the same. */
export class AttachmentNotFoundError extends ApplicationError {
  /** Report an unknown attachment without saying whether it exists elsewhere. */
  constructor() {
    super(404, "ATTACHMENT_NOT_FOUND", "This file is no longer available.");
  }
}

/** A new upload would exceed the number or combined size of files a message can carry. */
export class AttachmentLimitError extends ApplicationError {
  /** Name the limit that was reached and how to continue. */
  constructor(limit: "count" | "total") {
    super(
      409,
      "ATTACHMENT_LIMIT_REACHED",
      limit === "count"
        ? `You can attach up to ${attachmentLimits.maxFiles} files to a message. Send or remove some files first.`
        : `Files attached to one message can total up to ${attachmentLimits.maxTotalBytes / 1024 / 1024} MB. Send or remove some files first.`,
    );
  }
}

/** An upload sent more bytes than it declared or than one part may hold. */
export class AttachmentTooLargeError extends ApplicationError {
  /** Refuse the extra bytes; what was saved before this part is kept. */
  constructor() {
    super(
      413,
      "ATTACHMENT_TOO_LARGE",
      "This part of the file is larger than expected. Try uploading the file again.",
    );
  }
}

/** A part didn't start where the saved bytes end, for example after a retried request. */
export class AttachmentOffsetError extends ApplicationError {
  /** Ask the caller to continue from the saved position. */
  constructor() {
    super(
      409,
      "ATTACHMENT_OFFSET_MISMATCH",
      "This part doesn't continue the saved upload. Check how much was saved and continue from there.",
    );
  }
}

/** Bytes arrived for an attachment that is already complete. */
export class AttachmentCompleteError extends ApplicationError {
  /** Report that no more bytes are needed. */
  constructor() {
    super(
      409,
      "ATTACHMENT_COMPLETE",
      "This file has already finished uploading.",
    );
  }
}

/** Files already sent stay with their message, so the conversation keeps showing what was sent. */
export class AttachmentInUseError extends ApplicationError {
  /** Explain why a sent file can't be removed here. */
  constructor() {
    super(
      409,
      "ATTACHMENT_SENT",
      "This file was already sent in the conversation, so it can't be removed.",
    );
  }
}

/** A message named an attachment that isn't an unsent, fully uploaded file of this teammate. */
export class AttachmentUnavailableError extends ApplicationError {
  /** Keep the draft; nothing was sent. */
  constructor() {
    super(
      409,
      "ATTACHMENT_UNAVAILABLE",
      "One of the files isn't ready to send or is no longer available. Remove it or upload it again.",
    );
  }
}

/** The file couldn't be saved in the teammate's workspace. */
export class AttachmentStorageError extends ApplicationError {
  /** Report the failure without workspace paths or system details. */
  constructor() {
    super(
      500,
      "ATTACHMENT_STORAGE_FAILED",
      "The file couldn't be saved in your teammate's workspace. Try uploading it again.",
    );
  }
}
