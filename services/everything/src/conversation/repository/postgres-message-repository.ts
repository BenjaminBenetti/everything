import { randomUUID } from "node:crypto";
import {
  LessThan,
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

  /** Verify and lock the parent while inserting so concurrent deletion cannot invalidate ownership. */
  async append(
    scope: MessageScope,
    role: MessageRole,
    text: string,
  ): Promise<ConversationMessage> {
    return serializableTransaction(this.orm.manager, async (manager) =>
      this.toEntity(await this.insert(manager, scope, role, text)),
    );
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

  // ===========================================
  // Persistence
  // ===========================================

  /** Insert a message after locking the owned teammate within the caller's transaction. */
  private async insert(
    manager: EntityManager,
    { ownerId, agentId }: MessageScope,
    role: MessageRole,
    text: string,
  ): Promise<MessageRecord> {
    const agent = await manager.getRepository(AgentEntity).findOne({
      where: { id: agentId, ownerId },
      lock: { mode: "pessimistic_read" },
    });
    if (!agent) throw new AgentNotFoundError();
    const repository = manager.getRepository(MessageEntity);
    return repository.save(
      repository.create({ id: randomUUID(), agentId: agent.id, role, text }),
    );
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
