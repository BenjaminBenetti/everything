import type { Repository } from "@everything/persistence/repository";
import type {
  Attachment,
  AttachmentKind,
  AttachmentMaintenanceScope,
  AttachmentOwnerScope,
  AttachmentScope,
} from "../model/attachment.js";

/** What the service decides about a new upload; everything else starts empty. */
export interface NewAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly path: string;
}

/** Cutoffs after which unsent attachments are removed. */
export interface AttachmentExpiry {
  /** Uploads that received no bytes since then were abandoned. */
  readonly uploadingBefore: string;
  /** Complete files uploaded before then and never sent are no longer wanted. */
  readonly readyBefore: string;
}

/** An attachment found by maintenance, with the teammate whose workspace holds its file. */
export interface LocatedAttachment extends Attachment {
  readonly agentId: string;
}

/** Persistence boundary for attachments; sending one is part of saving its message. */
export interface AttachmentRepository extends Repository<
  Attachment,
  AttachmentScope
> {
  /** Save a new upload, verifying the teammate is the owner's under its lock. */
  create(
    scope: AttachmentOwnerScope,
    attachment: NewAttachment,
  ): Promise<Attachment>;
  /** Record how many bytes of an unfinished upload are saved. */
  progress(
    scope: AttachmentOwnerScope,
    id: string,
    received: number,
  ): Promise<Attachment>;
  /** Mark an upload complete with what its bytes showed it to be. */
  complete(
    scope: AttachmentOwnerScope,
    id: string,
    facts: { readonly kind: AttachmentKind; readonly mediaType: string },
  ): Promise<Attachment>;
  /** The teammate's unsent attachments, oldest first. */
  unsent(scope: AttachmentOwnerScope): Promise<Attachment[]>;
  /**
   * Remove an attachment that hasn't been sent, returning it, or undefined when it doesn't exist.
   * A sent attachment is refused, atomically with any concurrent send.
   */
  removeUnsent(
    scope: AttachmentOwnerScope,
    id: string,
  ): Promise<Attachment | undefined>;
  /** Find unsent attachments past their expiry, oldest first, in bounded batches. */
  expired(
    scope: AttachmentMaintenanceScope,
    expiry: AttachmentExpiry,
  ): Promise<LocatedAttachment[]>;
  /** Remove one attachment if it is still unsent and expired, returning it when removed. */
  removeExpired(
    scope: AttachmentMaintenanceScope,
    id: string,
    expiry: AttachmentExpiry,
  ): Promise<LocatedAttachment | undefined>;
}

/** Upload use cases need lookups, progress, and removal of unsent files. */
export type AttachmentStore = Pick<
  AttachmentRepository,
  "getById" | "create" | "progress" | "complete" | "unsent" | "removeUnsent"
>;

/** Expiry needs only the internal maintenance queries. */
export type AttachmentExpiryStore = Pick<
  AttachmentRepository,
  "getById" | "expired" | "removeExpired"
>;
