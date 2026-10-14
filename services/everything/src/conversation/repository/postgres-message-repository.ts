import { randomUUID } from "node:crypto";
import {
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
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

import type {
  MessageSummaryStore,
  SummaryDueScope,
} from "../../update/interface/message-summary-store.js";
import type {
  MessageSummaryInput,
  MessageSummaryTarget,
} from "../../update/model/message-summary.js";

/** Persist chat through ORM relations with transactional ownership checks. */
export class PostgresMessageRepository
  extends BaseRepository<ConversationMessage, MessageScope, MessageRecord>
  implements MessageRepository, MessageUpdates, MessageSummaryStore
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
    const messages = records.slice(0, updatePageSize).map((record) => ({
      ...this.toEntity(record),
      agentId: record.agentId,
      updateSummary: record.updateSummary,
      summaryStatus: record.summaryStatus,
      summaryStartedAt: record.summaryStartedAt,
    }));
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

  /** Discover only old-enough unread public replies, under an explicit internal maintenance scope. */
  async pendingSummaries({
    createdBefore,
  }: SummaryDueScope): Promise<MessageSummaryTarget[]> {
    if (
      !(createdBefore instanceof Date) ||
      !Number.isFinite(createdBefore.getTime())
    )
      throw new Error("Summary discovery requires a valid cutoff");
    const records = await this.orm.find({
      where: {
        role: "assistant",
        readAt: IsNull(),
        summaryStatus: "pending",
        createdAt: LessThanOrEqual(createdBefore.toISOString()),
      },
      relations: { agent: true },
      order: { sequence: "ASC" },
      take: 10,
    });
    return records.map((record) => ({
      id: record.id,
      agentId: record.agentId,
      ownerId: record.agent!.ownerId,
      createdAt: record.createdAt,
    }));
  }

  /** Commit the sole attempt before external inference; recheck ownership and unread state while locked. */
  async claimSummary(
    { ownerId, agentId }: MessageScope,
    messageId: string,
  ): Promise<MessageSummaryInput | undefined> {
    return serializableTransaction(this.orm.manager, async (manager) => {
      const agent = await manager.getRepository(AgentEntity).findOne({
        where: { id: agentId, ownerId },
        lock: { mode: "pessimistic_read" },
      });
      if (!agent) return undefined;
      const repository = manager.getRepository(MessageEntity);
      const message = await repository.findOne({
        where: {
          id: messageId,
          agentId: agent.id,
          role: "assistant",
          readAt: IsNull(),
          summaryStatus: "pending",
        },
        lock: { mode: "pessimistic_write" },
      });
      if (!message) return undefined;
      await repository.update(
        { id: message.id, agentId: agent.id, summaryStatus: "pending" },
        {
          summaryStatus: "generating",
          summaryStartedAt: new Date().toISOString(),
        },
      );
      return {
        id: message.id,
        agentId: agent.id,
        ownerId: agent.ownerId,
        createdAt: message.createdAt,
        text: message.text,
        inference: agent.inference,
      };
    });
  }

  /** Save a result once without resurrecting deleted conversations or repeating a failed request. */
  async finishSummary(
    { ownerId, agentId }: MessageScope,
    messageId: string,
    summary: string | null,
  ): Promise<void> {
    await serializableTransaction(this.orm.manager, async (manager) => {
      const agent = await manager.getRepository(AgentEntity).findOne({
        where: { id: agentId, ownerId },
        lock: { mode: "pessimistic_read" },
      });
      if (!agent) return;
      await manager.getRepository(MessageEntity).update(
        {
          id: messageId,
          agentId: agent.id,
          role: "assistant",
          summaryStatus: "generating",
        },
        {
          updateSummary: summary,
          summaryStatus: summary === null ? "failed" : "ready",
        },
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
