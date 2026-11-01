import { randomUUID } from "node:crypto";
import {
  IsNull,
  LessThan,
  MoreThan,
  ILike,
  type DataSource,
  type EntityManager,
  type FindOptionsWhere,
} from "typeorm";
import {
  messagePageSize,
  type MessagePage,
} from "@everything/conversation-contracts";
import { BaseRepository } from "@everything/persistence/repository";
import { serializableTransaction } from "@everything/persistence/transaction";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import type {
  MessageRepository,
  MessageScope,
} from "../interface/message-repository.js";
import type { ConversationMessage, MessageRole } from "../model/message.js";
import type { MessageRecord } from "../model/message-record.js";
import { MessageEntity } from "../schema/message-entity.js";
import { UpdateEntity } from "../../update/schema/update-entity.js";
import type { ConversationSearchInput } from "../schema/conversation-search.js";
import { AttachmentEntity } from "../../attachment/schema/attachment-entity.js";
import { AttachmentUnavailableError } from "../../attachment/error/attachment-errors.js";
import type { AttachmentRecord } from "../../attachment/model/attachment.js";
import { representMessageAttachment } from "../../attachment/presenter/attachment-presenter.js";

/** Visible messages are always read with the files sent with them. */
const withAttachments = { attachments: true } as const;

/** Persist chat through ORM relations with transactional ownership checks. */
export class PostgresMessageRepository
  extends BaseRepository<ConversationMessage, MessageScope, MessageRecord>
  implements MessageRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Reuse the mapped repository and inherit its scoped ORM defaults. */
  constructor(database: DataSource) {
    super(database.getRepository(MessageEntity), {
      order: { sequence: "ASC" },
    });
  }

  // ===========================================
  // Operations
  // ===========================================

  /**
   * Verify and lock the parent while inserting so concurrent deletion cannot invalidate ownership, and
   * claim the attachments in the same transaction, so a message is saved with all of them or not at all.
   */
  async append(
    scope: MessageScope,
    role: MessageRole,
    text: string,
    attachmentIds: readonly string[] = [],
  ): Promise<ConversationMessage> {
    return serializableTransaction(this.orm.manager, async (manager) => {
      const message = await this.insert(manager, scope, role, text);
      const attachments = await this.attach(manager, message, attachmentIds);
      return this.toEntity({ ...message, attachments });
    });
  }

  /** Commit the reply and its unread update together, so neither exists without the other. */
  async deliver(
    scope: MessageScope,
    text: string,
  ): Promise<ConversationMessage> {
    return serializableTransaction(this.orm.manager, async (manager) => {
      const message = await this.insert(manager, scope, "assistant", text);
      await manager.getRepository(UpdateEntity).insert({
        id: randomUUID(),
        ownerId: scope.ownerId,
        kind: "message",
        agentId: message.agentId,
        messageId: message.id,
      });
      return this.toEntity(message);
    });
  }

  /** Page by insertion order, checking the cursor against the same owner and teammate. */
  async page(scope: MessageScope, before?: string): Promise<MessagePage> {
    let where = this.scopeWhere(scope);
    if (before) {
      const cursor = await this.orm.findOneBy({ ...where, id: before });
      if (!cursor) return { messages: [], nextCursor: null };
      where = { ...where, sequence: LessThan(cursor.sequence) };
    }
    const records = await this.orm.find({
      where,
      relations: withAttachments,
      order: { sequence: "DESC" },
      take: messagePageSize + 1,
    });
    const messages = records
      .slice(0, messagePageSize)
      .reverse()
      .map((record) => this.toEntity(record));
    return {
      messages,
      nextCursor: records.length > messagePageSize ? messages[0]!.id : null,
    };
  }

  /** Search literal phrases without allowing SQL wildcard characters to broaden a query. */
  async search(
    scope: MessageScope,
    {
      query,
      limit,
      before,
      role,
    }: ConversationSearchInput & { readonly limit: number },
  ): Promise<MessagePage> {
    let where = this.scopeWhere(scope);
    if (before) {
      const cursor = await this.orm.findOneBy({ ...where, id: before });
      if (!cursor) return { messages: [], nextCursor: null };
      where = { ...where, sequence: LessThan(cursor.sequence) };
    }
    const literal = query.replace(/[\\%_]/g, "\\$&");
    const records = await this.orm.find({
      where: {
        ...where,
        text: ILike(`%${literal}%`),
        ...(role ? { role } : {}),
      },
      relations: withAttachments,
      order: { sequence: "DESC" },
      take: limit + 1,
    });
    const messages = records
      .slice(0, limit)
      .map((record) => this.toEntity(record));
    return {
      messages,
      nextCursor: records.length > limit ? messages.at(-1)!.id : null,
    };
  }

  /** Keep both adjacent lookups inside the same owner and teammate scope as the anchor. */
  async neighbors(
    scope: MessageScope,
    id: string,
  ): Promise<{
    before: ConversationMessage | null;
    after: ConversationMessage | null;
  }> {
    const where = this.scopeWhere(scope);
    const anchor = await this.orm.findOneBy({ ...where, id });
    if (!anchor) return { before: null, after: null };
    const [before, after] = await Promise.all([
      this.orm.findOne({
        where: { ...where, sequence: LessThan(anchor.sequence) },
        relations: withAttachments,
        order: { sequence: "DESC" },
      }),
      this.orm.findOne({
        where: { ...where, sequence: MoreThan(anchor.sequence) },
        relations: withAttachments,
        order: { sequence: "ASC" },
      }),
    ]);
    return {
      before: before ? this.toEntity(before) : null,
      after: after ? this.toEntity(after) : null,
    };
  }

  // ===========================================
  // Persistence
  // ===========================================

  /** Insert under the owned teammate's lock, advancing recency only for a user's sent message. */
  private async insert(
    manager: EntityManager,
    { ownerId, agentId }: MessageScope,
    role: MessageRole,
    text: string,
  ): Promise<MessageRecord> {
    const agent = await manager.getRepository(AgentEntity).findOne({
      where: { id: agentId, ownerId },
      lock: {
        mode: role === "user" ? "pessimistic_write" : "pessimistic_read",
      },
    });
    if (!agent) throw new AgentNotFoundError();
    const repository = manager.getRepository(MessageEntity);
    const message = await repository.save(
      repository.create({ id: randomUUID(), agentId: agent.id, role, text }),
    );
    if (
      role === "user" &&
      (!agent.lastInteractedAt ||
        Date.parse(message.createdAt) > Date.parse(agent.lastInteractedAt))
    )
      await manager
        .getRepository(AgentEntity)
        .update(
          { id: agent.id, ownerId },
          { lastInteractedAt: message.createdAt },
        );
    return message;
  }

  /**
   * Claim each named attachment for the message, in order. Each must be a complete, unsent upload of
   * the same teammate, whose owner `insert` already verified; anything else fails the whole message.
   */
  private async attach(
    manager: EntityManager,
    message: MessageRecord,
    attachmentIds: readonly string[],
  ): Promise<AttachmentRecord[]> {
    const repository = manager.getRepository(AttachmentEntity);
    const attached: AttachmentRecord[] = [];
    for (const [position, id] of attachmentIds.entries()) {
      const record = await repository.findOne({
        where: {
          id,
          agentId: message.agentId,
          status: "ready",
          messageId: IsNull(),
        },
        lock: { mode: "pessimistic_write" },
      });
      if (!record) throw new AttachmentUnavailableError();
      await repository.update(
        { id: record.id },
        { messageId: message.id, position },
      );
      attached.push({ ...record, messageId: message.id, position });
    }
    return attached;
  }

  // ===========================================
  // Domain policy
  // ===========================================

  /** Let TypeORM construct the relation filter for owner and conversation scope. */
  protected scopeWhere({
    ownerId,
    agentId,
  }: MessageScope): FindOptionsWhere<MessageRecord> {
    return { agentId, agent: { ownerId } };
  }

  /** Exclude the relation, foreign key, and ordering counter from visible chat; attachments keep their order. */
  protected toEntity({
    id,
    role,
    text,
    createdAt,
    attachments = [],
  }: MessageRecord): ConversationMessage {
    return {
      id,
      role,
      text,
      createdAt,
      attachments: [...attachments]
        .sort((first, second) => (first.position ?? 0) - (second.position ?? 0))
        .map(representMessageAttachment),
    };
  }
}
