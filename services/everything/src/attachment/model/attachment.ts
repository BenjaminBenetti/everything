import type { BaseEntity } from "@everything/persistence/entity";
import type { OwnerScope } from "@everything/persistence/repository";
import type { AttachmentUpload } from "@everything/conversation-contracts/attachment";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { MessageRecord } from "../../conversation/model/message-record.js";
export {
  attachmentLimits,
  type AttachmentKind,
  type AttachmentUpload,
  type AttachmentUploadList,
  type MessageAttachment,
} from "@everything/conversation-contracts/attachment";

/** A file the user attached for a teammate: uploading, uploaded and unsent, or sent with a message. */
export interface Attachment extends BaseEntity, AttachmentUpload {
  /** The message that carries it; null until it is sent. */
  readonly messageId: string | null;
  /** When the upload began or last received bytes, so abandoned uploads can be removed. */
  readonly updatedAt: string;
}

/** Ownership follows the teammate relation; position orders a message's attachments. */
export interface AttachmentRecord extends Attachment {
  readonly agentId: string;
  readonly agent?: AgentDefinition;
  readonly message?: MessageRecord;
  readonly position: number | null;
}

/** Limit attachment access to one teammate owned by the authenticated subject. */
export interface AttachmentOwnerScope extends OwnerScope {
  readonly agentId: string;
}

/** Explicit internal maintenance scope for removing expired uploads; never used by user requests. */
export interface AttachmentMaintenanceScope {
  readonly ownership: "all";
}

export type AttachmentScope = AttachmentOwnerScope | AttachmentMaintenanceScope;

/** What the server needs to know to place an attachment's file, without anything the caller chose. */
export interface AttachmentLocation {
  readonly agentId: string;
  readonly id: string;
  /** Name of the file inside the attachment's own folder, derived by `storedFileName`. */
  readonly fileName: string;
}
