import type {
  AttachmentUpload,
  AttachmentUploadList,
} from "@everything/conversation-contracts/attachment";

/** Browser capabilities for uploading files into a teammate's workspace for the next message. */
export interface AttachmentClient {
  /** Read the files uploaded or uploading for the next message, so a reload keeps them. */
  unsent(agentId: string, signal?: AbortSignal): Promise<AttachmentUploadList>;
  /** Reserve an upload; the server chooses its path and tells what it is from its bytes. */
  create(
    agentId: string,
    file: { readonly name: string; readonly size: number },
  ): Promise<AttachmentUpload>;
  /** Send one part of the file starting at `offset`, the upload's received count. */
  upload(
    agentId: string,
    attachmentId: string,
    offset: number,
    part: Blob,
    signal: AbortSignal,
  ): Promise<AttachmentUpload>;
  /** Cancel an upload or remove an unsent file. */
  remove(agentId: string, attachmentId: string): Promise<void>;
  /** Address of a complete file, for previews and downloads. */
  contentUrl(agentId: string, attachmentId: string): string;
}
