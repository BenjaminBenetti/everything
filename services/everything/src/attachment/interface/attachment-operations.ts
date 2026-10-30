import type { Readable } from "node:stream";
import type {
  AttachmentKind,
  AttachmentUpload,
  AttachmentUploadList,
} from "../model/attachment.js";
import type { CreateAttachmentBody } from "../schema/attachment-request.js";

/** A complete attachment's file, ready to send to the owner. */
export interface AttachmentDownload {
  readonly name: string;
  readonly kind: AttachmentKind;
  readonly mediaType: string;
  readonly size: number;
  readonly stream: Readable;
}

/** Attachment use cases for a teammate owned by the authenticated subject. */
export interface AttachmentOperations {
  /** Begin an upload within the per-message limits; an empty file is complete at once. */
  create(
    ownerId: string,
    agentId: string,
    input: CreateAttachmentBody,
  ): Promise<AttachmentUpload>;
  /** Save the next part of an upload; the last part places the file in the teammate's workspace. */
  append(
    ownerId: string,
    agentId: string,
    attachmentId: string,
    offset: number,
    body: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<AttachmentUpload>;
  /** List attachments uploaded or uploading for the next message. */
  unsent(ownerId: string, agentId: string): Promise<AttachmentUploadList>;
  /** Open a complete attachment's file, sent or not. */
  content(
    ownerId: string,
    agentId: string,
    attachmentId: string,
  ): Promise<AttachmentDownload>;
  /** Cancel an upload or remove an unsent file; sent files stay with their message. */
  remove(ownerId: string, agentId: string, attachmentId: string): Promise<void>;
}
