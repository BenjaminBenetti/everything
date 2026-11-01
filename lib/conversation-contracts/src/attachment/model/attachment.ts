/**
 * Limits that the composer and the server both apply to files attached to messages. Files go to the
 * teammate's workspace; a message carries only their paths and a few facts about them.
 */
export const attachmentLimits = {
  /** Largest single file. */
  maxFileBytes: 25 * 1024 * 1024,
  /** Most files in one message, and most unsent files one teammate holds at a time. */
  maxFiles: 10,
  /** Combined size of one message's files, and of one teammate's unsent files. */
  maxTotalBytes: 100 * 1024 * 1024,
  /**
   * Bytes the composer sends per request: small enough to finish well within the server's request
   * timeout on a slow connection, and within common ingress body limits such as ingress-nginx's 1 MiB.
   */
  chunkBytes: 1024 * 1024,
  /** Largest part the server accepts in one request. */
  maxChunkBytes: 4 * 1024 * 1024,
  /** Longest file name kept for display. */
  nameLength: 255,
  /** How long an attachment that was uploaded but never sent is kept before it is removed. */
  unsentRetentionMs: 24 * 60 * 60 * 1000,
} as const;

/**
 * What the server found the file to be from its bytes, never from the name or type the browser gave:
 * a PNG, JPEG, GIF, or WebP image; UTF-8 text; or anything else.
 */
export type AttachmentKind = "image" | "text" | "binary";

/** A file attached to a sent message: where the teammate finds it, and small facts about it. */
export interface MessageAttachment {
  readonly id: string;
  /** The file's name as the user chose it, for display only; it never names a path. */
  readonly name: string;
  readonly size: number;
  readonly kind: AttachmentKind;
  /** Media type the server determined from the file's bytes. */
  readonly mediaType: string;
  /** Server-chosen absolute path of the file in the teammate's workspace. */
  readonly path: string;
}

/** An attachment that is uploading, or uploaded and waiting to be sent with a message. */
export interface AttachmentUpload {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  /** Bytes saved so far; the next part must start here. */
  readonly received: number;
  readonly status: "uploading" | "ready";
  /** Known once every byte has arrived. */
  readonly kind: AttachmentKind | null;
  readonly mediaType: string | null;
  /** Where the file will be in the teammate's workspace once it is ready. */
  readonly path: string;
}

/** A teammate's unsent attachments, oldest first. */
export interface AttachmentUploadList {
  readonly attachments: readonly AttachmentUpload[];
}
