import { randomUUID } from "node:crypto";
import type { DataSource, FindOptionsWhere } from "typeorm";
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

/** Newest messages returned by a listing; older history stays stored but is not returned. */
const listedMessageLimit = 100;

/** Persist chat through ORM relations with transactional ownership checks. */
export class PostgresMessageRepository
  extends BaseRepository<ConversationMessage, MessageScope, MessageRecord>
  implements MessageRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Reuse the data source and bound listings to the newest messages. */
  constructor(database: DataSource) {
    super(database.getRepository(MessageEntity), {
      order: { sequence: "DESC" },
      take: listedMessageLimit,
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

  /** Present the bounded latest-message result in chronological order. */
  override async list(scope: MessageScope): Promise<ConversationMessage[]> {
    return (await super.list(scope)).reverse();
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
