import {
  IsNull,
  LessThan,
  Not,
  type DataSource,
  type EntityManager,
  type FindOptionsWhere,
} from "typeorm";
import { BaseRepository } from "@everything/persistence/repository";
import { serializableTransaction } from "@everything/persistence/transaction";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import {
  AttachmentInUseError,
  AttachmentNotFoundError,
} from "../error/attachment-errors.js";
import type {
  AttachmentExpiry,
  AttachmentRepository,
  LocatedAttachment,
  NewAttachment,
} from "../interface/attachment-repository.js";
import type {
  Attachment,
  AttachmentKind,
  AttachmentMaintenanceScope,
  AttachmentOwnerScope,
  AttachmentRecord,
  AttachmentScope,
} from "../model/attachment.js";
import { AttachmentEntity } from "../schema/attachment-entity.js";

/** Most expired attachments one maintenance query returns. */
const expiryBatchSize = 100;

/** Persist attachments through ORM relations with transactional ownership checks. */
export class PostgresAttachmentRepository
  extends BaseRepository<Attachment, AttachmentScope, AttachmentRecord>
  implements AttachmentRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Reuse the mapped repository and inherit its scoped ORM defaults. */
  constructor(database: DataSource) {
    super(database.getRepository(AttachmentEntity), {
      order: { createdAt: "ASC", id: "ASC" },
    });
  }

  // ===========================================
  // Uploads
  // ===========================================

  /** Insert under the owned teammate's lock so concurrent deletion can't orphan the record. */
  async create(
    scope: AttachmentOwnerScope,
    attachment: NewAttachment,
  ): Promise<Attachment> {
    return serializableTransaction(this.orm.manager, async (manager) => {
      const agent = await manager.getRepository(AgentEntity).findOne({
        where: { id: scope.agentId, ownerId: scope.ownerId },
        lock: { mode: "pessimistic_read" },
      });
      if (!agent) throw new AgentNotFoundError();
      const repository = manager.getRepository(AttachmentEntity);
      return this.toEntity(
        await repository.save(
          repository.create({
            ...attachment,
            agentId: agent.id,
            messageId: null,
            position: null,
            received: 0,
            status: "uploading",
            kind: null,
            mediaType: null,
            updatedAt: new Date().toISOString(),
          }),
        ),
      );
    });
  }

  /** Advance an unfinished upload found within scope. */
  async progress(
    scope: AttachmentOwnerScope,
    id: string,
    received: number,
  ): Promise<Attachment> {
    return this.updateUploading(scope, id, { received });
  }

  /** Complete an unfinished upload found within scope with what its bytes showed. */
  async complete(
    scope: AttachmentOwnerScope,
    id: string,
    { kind, mediaType }: { kind: AttachmentKind; mediaType: string },
  ): Promise<Attachment> {
    return this.updateUploading(scope, id, (record) => ({
      received: record.size,
      status: "ready",
      kind,
      mediaType,
    }));
  }

  /** The composer's attachments: everything not yet sent, oldest first. */
  async unsent(scope: AttachmentOwnerScope): Promise<Attachment[]> {
    const records = await this.orm.find({
      where: { ...this.scopeWhere(scope), messageId: IsNull() },
      order: { createdAt: "ASC", id: "ASC" },
    });
    return records.map((record) => this.toEntity(record));
  }

  /** Decide and remove in one serializable transaction, so a concurrent send either wins or fails. */
  async removeUnsent(
    scope: AttachmentOwnerScope,
    id: string,
  ): Promise<Attachment | undefined> {
    return serializableTransaction(this.orm.manager, async (manager) => {
      const repository = manager.getRepository(AttachmentEntity);
      const record = await repository.findOneBy({
        ...this.scopeWhere(scope),
        id,
      });
      if (!record) return undefined;
      if (record.messageId) throw new AttachmentInUseError();
      await repository.remove(record);
      return this.toEntity(record);
    });
  }

  // ===========================================
  // Expiry
  // ===========================================

  /** Unsent uploads past either cutoff, oldest first. */
  async expired(
    scope: AttachmentMaintenanceScope,
    expiry: AttachmentExpiry,
  ): Promise<LocatedAttachment[]> {
    const records = await this.orm.find({
      where: this.expiredWhere(scope, expiry),
      order: { updatedAt: "ASC", id: "ASC" },
      take: expiryBatchSize,
    });
    return records.map((record) => this.toLocated(record));
  }

  /** Check expiry again inside the transaction; an upload that progressed or was sent is kept. */
  async removeExpired(
    scope: AttachmentMaintenanceScope,
    id: string,
    expiry: AttachmentExpiry,
  ): Promise<LocatedAttachment | undefined> {
    return serializableTransaction(this.orm.manager, async (manager) => {
      const repository = manager.getRepository(AttachmentEntity);
      const record = await repository.findOne({
        where: this.expiredWhere(scope, expiry).map((where) => ({
          ...where,
          id,
        })),
      });
      if (!record) return undefined;
      await repository.remove(record);
      return this.toLocated(record);
    });
  }

  // ===========================================
  // Persistence
  // ===========================================

  /** Update an unfinished upload by primary key after finding it within scope in the same transaction. */
  private updateUploading(
    scope: AttachmentOwnerScope,
    id: string,
    changes:
      | Partial<AttachmentRecord>
      | ((record: AttachmentRecord) => Partial<AttachmentRecord>),
  ): Promise<Attachment> {
    return serializableTransaction(
      this.orm.manager,
      async (manager: EntityManager) => {
        const repository = manager.getRepository(AttachmentEntity);
        const record = await repository.findOneBy({
          ...this.scopeWhere(scope),
          id,
          status: "uploading",
        });
        if (!record) throw new AttachmentNotFoundError();
        const updated = {
          ...(typeof changes === "function" ? changes(record) : changes),
          updatedAt: new Date().toISOString(),
        };
        await repository.update({ id: record.id }, updated);
        return this.toEntity({ ...record, ...updated });
      },
    );
  }

  /** Either arm of expiry, both limited to unsent attachments within the maintenance scope. */
  private expiredWhere(
    scope: AttachmentMaintenanceScope,
    { uploadingBefore, readyBefore }: AttachmentExpiry,
  ): FindOptionsWhere<AttachmentRecord>[] {
    const unsent = { ...this.scopeWhere(scope), messageId: IsNull() };
    return [
      { ...unsent, status: "uploading", updatedAt: LessThan(uploadingBefore) },
      { ...unsent, status: "ready", updatedAt: LessThan(readyBefore) },
    ];
  }

  // ===========================================
  // Domain policy
  // ===========================================

  /** Owner requests are limited to one owned teammate; maintenance must name its scope explicitly. */
  protected scopeWhere(
    scope: AttachmentScope,
  ): FindOptionsWhere<AttachmentRecord> {
    if ("ownership" in scope) {
      if (scope.ownership !== "all")
        throw new Error(
          "Attachment maintenance requires an explicit ownership scope",
        );
      return { agentId: Not(IsNull()) };
    }
    return { agentId: scope.agentId, agent: { ownerId: scope.ownerId } };
  }

  /** Exclude the relations, foreign key, and ordering from the domain projection. */
  protected toEntity({
    id,
    createdAt,
    name,
    size,
    received,
    status,
    kind,
    mediaType,
    path,
    messageId,
    updatedAt,
  }: AttachmentRecord): Attachment {
    return {
      id,
      createdAt,
      name,
      size,
      received,
      status,
      kind,
      mediaType,
      path,
      messageId,
      updatedAt,
    };
  }

  /** Include the teammate identity maintenance needs to find the file. */
  private toLocated(record: AttachmentRecord): LocatedAttachment {
    return { ...this.toEntity(record), agentId: record.agentId };
  }
}
