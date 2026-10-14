import { randomUUID } from "node:crypto";
import {
  In,
  IsNull,
  LessThan,
  type DataSource,
  type FindOptionsWhere,
} from "typeorm";
import {
  messagePageSize,
  updatePageSize,
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
import type { OwnerScope } from "@everything/persistence/repository";
import type {
  MessageUpdates,
  UnreadMessagePage,
} from "../../update/interface/message-updates.js";

/** Persist chat through ORM relations with transactional ownership checks. */
export class PostgresMessageRepository
  extends BaseRepository<ConversationMessage, MessageScope, MessageRecord>
  implements MessageRepository, MessageUpdates
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

  /** Verify and lock the parent while inserting so concurrent deletion cannot invalidate ownership. */
  async append(
    { ownerId, agentId }: MessageScope,
    role: MessageRole,
    text: string,
  ): Promise<ConversationMessage> {
    return serializableTransaction(this.orm.manager, async (manager) => {
      const agent = await manager.getRepository(AgentEntity).findOne({
        where: { id: agentId, ownerId },
        lock: { mode: "pessimistic_read" },
      });
      if (!agent) throw new AgentNotFoundError();
      const repository = manager.getRepository(MessageEntity);
      return this.toEntity(
        await repository.save(
          repository.create({ id: randomUUID(), agentId, role, text }),
        ),
      );
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

  /** Read only deliberately delivered assistant messages; a read cursor still bounds the next page. */
  async unread(
    { ownerId }: OwnerScope,
    before?: string,
  ): Promise<UnreadMessagePage> {
    let where: FindOptionsWhere<MessageRecord> = {
      agent: { ownerId },
      role: "assistant",
      readAt: IsNull(),
    };
    if (before) {
      const cursor = await this.orm.findOneBy({
        agent: { ownerId },
        id: before,
        role: "assistant",
      });
      if (!cursor) return { messages: [], nextCursor: null };
      where = { ...where, sequence: LessThan(cursor.sequence) };
    }
    const records = await this.orm.find({
      where,
      order: { sequence: "DESC" },
      take: updatePageSize + 1,
    });
    const messages = records
      .slice(0, updatePageSize)
      .map((record) => ({ ...this.toEntity(record), agentId: record.agentId }));
    return {
      messages,
      nextCursor: records.length > updatePageSize ? messages.at(-1)!.id : null,
    };
  }

  /** Lock and verify the parent in the same transaction as the exact, monotonic receipt update. */
  async markRead(
    { ownerId, agentId }: MessageScope,
    messageIds: readonly string[],
  ): Promise<void> {
    await serializableTransaction(this.orm.manager, async (manager) => {
      const agent = await manager.getRepository(AgentEntity).findOne({
        where: { id: agentId, ownerId },
        lock: { mode: "pessimistic_read" },
      });
      if (!agent) throw new AgentNotFoundError();
      if (!messageIds.length) return;
      await manager.getRepository(MessageEntity).update(
        {
          agentId: agent.id,
          id: In([...messageIds]),
          role: "assistant",
          readAt: IsNull(),
        },
        { readAt: new Date().toISOString() },
      );
    });
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

  /** Exclude the relation, foreign key, and ordering counter from visible chat. */
  protected toEntity({
    id,
    role,
    text,
    createdAt,
  }: MessageRecord): ConversationMessage {
    return { id, role, text, createdAt };
  }
}
