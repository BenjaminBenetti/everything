import type { AttachmentFiles } from "../interface/attachment-files.js";
import type { AttachmentExpiryStore } from "../interface/attachment-repository.js";
import {
  attachmentLocation,
  attachmentRetention,
} from "../model/attachment-file.js";

const maintenance = { ownership: "all" } as const;

/**
 * Remove attachments nobody will send: uploads that stopped receiving bytes, files uploaded but not
 * sent within the retention period, and partial files whose upload record no longer exists. Sent
 * attachments are never touched; they stay as long as their teammate.
 */
export class AttachmentExpiry {
  // ===========================================
  // Construction
  // ===========================================

  /** Depend on maintenance queries, the file storage, and a clock. */
  constructor(
    private readonly attachments: AttachmentExpiryStore,
    private readonly files: AttachmentFiles,
    private readonly now: () => number = Date.now,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** One pass: expired records with their files, then partial files left without a record. */
  async expire(): Promise<void> {
    const now = this.now();
    const expiry = {
      uploadingBefore: new Date(
        now - attachmentRetention.staleUploadMs,
      ).toISOString(),
      readyBefore: new Date(now - attachmentRetention.unsentMs).toISOString(),
    };
    for (const candidate of await this.attachments.expired(
      maintenance,
      expiry,
    )) {
      const removed = await this.attachments.removeExpired(
        maintenance,
        candidate.id,
        expiry,
      );
      if (!removed) continue;
      await this.files.discard(removed.id);
      await this.files.remove(
        attachmentLocation(removed.agentId, removed.id, removed.path),
      );
    }
    for (const id of await this.files.partials(
      now - attachmentRetention.staleUploadMs,
    )) {
      const attachment = await this.attachments.getById(maintenance, id);
      if (attachment?.status !== "uploading") await this.files.discard(id);
    }
  }
}
