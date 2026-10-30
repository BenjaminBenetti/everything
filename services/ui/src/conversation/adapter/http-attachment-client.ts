import type {
  AttachmentUpload,
  AttachmentUploadList,
} from "@everything/conversation-contracts/attachment";
import type { BinaryTransport } from "../../http/interface/binary-transport.js";
import type { JsonTransport } from "../../http/interface/json-transport.js";
import type { AttachmentClient } from "../interface/attachment-client.js";

/** Map attachments to the authenticated teammate-scoped endpoints. */
export class HttpAttachmentClient implements AttachmentClient {
  // ===========================================
  // Construction
  // ===========================================

  /** Share the application's cookie and error handling policy. */
  constructor(private readonly transport: JsonTransport & BinaryTransport) {}

  // ===========================================
  // Operations
  // ===========================================

  /** List the teammate's unsent attachments. */
  unsent(agentId: string, signal?: AbortSignal): Promise<AttachmentUploadList> {
    return this.transport.request(this.path(agentId), signal ? { signal } : {});
  }

  /** Send only the file's name and size; the server ignores the browser's path and type. */
  create(
    agentId: string,
    file: { readonly name: string; readonly size: number },
  ): Promise<AttachmentUpload> {
    return this.transport.request(this.path(agentId), {
      method: "POST",
      body: JSON.stringify({ name: file.name, size: file.size }),
    });
  }

  /** Upload one part as raw bytes; a failed part can be sent again from the same offset. */
  upload(
    agentId: string,
    attachmentId: string,
    offset: number,
    part: Blob,
    signal: AbortSignal,
  ): Promise<AttachmentUpload> {
    return this.transport.upload(
      `${this.path(agentId, attachmentId)}/content?${new URLSearchParams({ offset: String(offset) })}`,
      part,
      "application/octet-stream",
      signal,
    );
  }

  /** Remove an upload; removing one that's already gone succeeds. */
  remove(agentId: string, attachmentId: string): Promise<void> {
    return this.transport.request(this.path(agentId, attachmentId), {
      method: "DELETE",
    });
  }

  /** The same-origin address the browser loads previews and downloads from with its session. */
  contentUrl(agentId: string, attachmentId: string): string {
    return `${this.path(agentId, attachmentId)}/content`;
  }

  /** The teammate's attachments collection, or one attachment in it. */
  private path(agentId: string, attachmentId?: string): string {
    const collection = `/v1/agents/${encodeURIComponent(agentId)}/attachments`;
    return attachmentId
      ? `${collection}/${encodeURIComponent(attachmentId)}`
      : collection;
  }
}
