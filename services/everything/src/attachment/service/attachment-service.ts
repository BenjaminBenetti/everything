import { randomUUID } from "node:crypto";
import AsyncLock from "async-lock";
import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import {
  AttachmentCompleteError,
  AttachmentLimitError,
  AttachmentNotFoundError,
  AttachmentOffsetError,
} from "../error/attachment-errors.js";
import type { AttachmentFiles } from "../interface/attachment-files.js";
import type {
  AttachmentDownload,
  AttachmentOperations,
} from "../interface/attachment-operations.js";
import type { AttachmentStore } from "../interface/attachment-repository.js";
import {
  attachmentLimits,
  type Attachment,
  type AttachmentOwnerScope,
  type AttachmentUpload,
  type AttachmentUploadList,
} from "../model/attachment.js";
import {
  attachmentLocation,
  attachmentPath,
  attachmentSniffBytes,
  classifyAttachment,
  displayName,
  storedFileName,
} from "../model/attachment-file.js";
import { representUpload } from "../presenter/attachment-presenter.js";
import type { CreateAttachmentBody } from "../schema/attachment-request.js";

/**
 * Upload files into a teammate's workspace in bounded parts, then hand them to a message as small
 * references. Starting uploads is serialized per teammate, so the per-message limits hold across
 * browser tabs, and each upload's parts are serialized, so retries can't interleave.
 */
export class AttachmentService implements AttachmentOperations {
  // ===========================================
  // State and construction
  // ===========================================

  private readonly locks = new AsyncLock();

  /** Depend on teammate ownership, attachment records, and the file storage. */
  constructor(
    private readonly agents: Pick<AgentCatalog, "get">,
    private readonly attachments: AttachmentStore,
    private readonly files: AttachmentFiles,
  ) {}

  // ===========================================
  // Uploads
  // ===========================================

  /** Choose the file's identity and path on the server, ignoring any path in the user's file name. */
  async create(
    ownerId: string,
    agentId: string,
    { name, size }: CreateAttachmentBody,
  ): Promise<AttachmentUpload> {
    const scope = { ownerId, agentId };
    await this.agents.get(ownerId, agentId);
    return this.locks.acquire(`agent:${agentId}`, async () => {
      const unsent = await this.attachments.unsent(scope);
      if (unsent.length >= attachmentLimits.maxFiles)
        throw new AttachmentLimitError("count");
      const pending = unsent.reduce((total, item) => total + item.size, 0);
      if (pending + size > attachmentLimits.maxTotalBytes)
        throw new AttachmentLimitError("total");
      const location = {
        agentId,
        id: randomUUID(),
        fileName: storedFileName(name),
      };
      await this.files.begin(location.id);
      let attachment: Attachment;
      try {
        attachment = await this.attachments.create(scope, {
          id: location.id,
          name: displayName(name),
          size,
          path: attachmentPath(location),
        });
      } catch (error) {
        await this.files.discard(location.id);
        throw error;
      }
      return representUpload(
        size === 0 ? await this.finish(scope, attachment) : attachment,
      );
    });
  }

  /** Append one part at the saved position; the part that completes the file publishes it. */
  async append(
    ownerId: string,
    agentId: string,
    attachmentId: string,
    offset: number,
    body: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<AttachmentUpload> {
    const scope = { ownerId, agentId };
    await this.agents.get(ownerId, agentId);
    return this.locks.acquire(`upload:${attachmentId}`, async () => {
      const attachment = await this.attachments.getById(scope, attachmentId);
      if (!attachment || attachment.messageId)
        throw new AttachmentNotFoundError();
      if (attachment.status !== "uploading")
        throw new AttachmentCompleteError();
      if (offset !== attachment.received) throw new AttachmentOffsetError();
      const written = await this.files.append(
        attachment.id,
        offset,
        body,
        Math.min(attachmentLimits.maxChunkBytes, attachment.size - offset),
        signal,
      );
      const received = offset + written;
      return representUpload(
        received < attachment.size
          ? await this.attachments.progress(scope, attachmentId, received)
          : await this.finish(scope, { ...attachment, received }),
      );
    });
  }

  /** The composer's attachments, so they survive a reload and are shared by the owner's tabs. */
  async unsent(
    ownerId: string,
    agentId: string,
  ): Promise<AttachmentUploadList> {
    await this.agents.get(ownerId, agentId);
    const attachments = await this.attachments.unsent({ ownerId, agentId });
    return { attachments: attachments.map(representUpload) };
  }

  /** Open the file at its saved path; a file the teammate moved or replaced with a link is gone. */
  async content(
    ownerId: string,
    agentId: string,
    attachmentId: string,
  ): Promise<AttachmentDownload> {
    await this.agents.get(ownerId, agentId);
    const attachment = await this.attachments.getById(
      { ownerId, agentId },
      attachmentId,
    );
    if (
      attachment?.status !== "ready" ||
      !attachment.kind ||
      !attachment.mediaType
    )
      throw new AttachmentNotFoundError();
    const file = await this.files.open(this.locate(agentId, attachment));
    if (!file) throw new AttachmentNotFoundError();
    return {
      name: attachment.name,
      kind: attachment.kind,
      mediaType: attachment.mediaType,
      size: file.size,
      stream: file.stream,
    };
  }

  /** Remove the record first, atomically with sending, then its partial or complete file. */
  async remove(
    ownerId: string,
    agentId: string,
    attachmentId: string,
  ): Promise<void> {
    await this.agents.get(ownerId, agentId);
    await this.locks.acquire(`upload:${attachmentId}`, async () => {
      const removed = await this.attachments.removeUnsent(
        { ownerId, agentId },
        attachmentId,
      );
      if (removed) await this.removeFiles(agentId, removed);
    });
  }

  // ===========================================
  // Files
  // ===========================================

  /**
   * Tell what the complete file is from its first bytes, then place it in the teammate's workspace.
   * A file that can't be placed is removed with its record, so nothing half-saved is left behind.
   */
  private async finish(
    scope: AttachmentOwnerScope,
    attachment: Attachment,
  ): Promise<Attachment> {
    const location = this.locate(scope.agentId, attachment);
    try {
      const facts = classifyAttachment(
        await this.files.head(attachment.id, attachmentSniffBytes),
      );
      await this.files.publish(location);
      return await this.attachments.complete(scope, attachment.id, facts);
    } catch (error) {
      await this.attachments
        .removeUnsent(scope, attachment.id)
        .catch(() => undefined);
      await this.removeFiles(scope.agentId, attachment);
      throw error;
    }
  }

  /** Remove whatever exists of an attachment's files. */
  private async removeFiles(
    agentId: string,
    attachment: Attachment,
  ): Promise<void> {
    await this.files.discard(attachment.id);
    await this.files.remove(this.locate(agentId, attachment));
  }

  /** Derive the file's location from the saved, server-generated path. */
  private locate(agentId: string, attachment: Attachment) {
    return attachmentLocation(agentId, attachment.id, attachment.path);
  }
}
