import {
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
  type DataSource,
  type FindOptionsWhere,
} from "typeorm";
import {
  BaseRepository,
  type OwnerScope,
} from "@everything/persistence/repository";
import { serializableTransaction } from "@everything/persistence/transaction";
import { updatePageSize } from "@everything/update-contracts";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import type { MessageScope } from "../../conversation/interface/message-repository.js";
import type { UpdateRepository } from "../interface/update-repository.js";
import type { StoredUpdate, UnreadUpdatePage } from "../model/stored-update.js";
import type { UpdateRecord } from "../model/update-record.js";
import type {
  SummaryDueScope,
  UpdateSummaryInput,
  UpdateSummaryTarget,
} from "../model/update-summary.js";
import { UpdateEntity } from "../schema/update-entity.js";

/** Persist directly owned updates, applying the owner scope to every feed, receipt, and summary query. */
export class PostgresUpdateRepository
  extends BaseRepository<StoredUpdate, OwnerScope, UpdateRecord>
  implements UpdateRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the mapped repository; listings are newest first and bounded to one feed page. */
  constructor(database: DataSource) {
    super(database.getRepository(UpdateEntity), {
      order: { sequence: "DESC" },
      take: updatePageSize,
    });
  }

  // ===========================================
  // Feed
  // ===========================================

  /** Bound the page by the cursor's insertion order, whether or not the cursor itself is still unread. */
  async unread(scope: OwnerScope, before?: string): Promise<UnreadUpdatePage> {
    let where: FindOptionsWhere<UpdateRecord> = {
      ...this.scopeWhere(scope),
      readAt: IsNull(),
    };
    if (before) {
      const cursor = await this.orm.findOne({
        where: { ...this.scopeWhere(scope), id: before },
        loadEagerRelations: false,
      });
      if (!cursor) return { updates: [], nextCursor: null };
      where = { ...where, sequence: LessThan(cursor.sequence) };
    }
    const records = await this.orm.find({
      where,
      order: { sequence: "DESC" },
      take: updatePageSize + 1,
    });
    const updates = records
      .slice(0, updatePageSize)
      .map((record) => this.toEntity(record));
    return {
      updates,
      nextCursor: records.length > updatePageSize ? updates.at(-1)!.id : null,
    };
  }

  /** Count from the unread index alone, without loading any source. */
  async countUnread(scope: OwnerScope): Promise<number> {
    return this.orm.count({
      where: { ...this.scopeWhere(scope), readAt: IsNull() },
      loadEagerRelations: false,
    });
  }

  /** Lock the owned teammate in the same transaction as the exact, first-receipt-only update. */
  async readMessages(
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
      await manager.getRepository(UpdateEntity).update(
        {
          ...this.scopeWhere({ ownerId }),
          kind: "message",
          agentId: agent.id,
          messageId: In([...messageIds]),
          readAt: IsNull(),
        },
        { readAt: new Date().toISOString() },
      );
    });
  }

  // ===========================================
  // Summaries
  // ===========================================

  /** Discover the oldest unread pending updates under an explicit internal maintenance scope. */
  async pendingSummaries({
    createdBefore,
  }: SummaryDueScope): Promise<UpdateSummaryTarget[]> {
    if (
      !(createdBefore instanceof Date) ||
      !Number.isFinite(createdBefore.getTime())
    )
      throw new Error("Summary discovery requires a valid cutoff");
    const records = await this.orm.find({
      where: {
        readAt: IsNull(),
        summaryStatus: "pending",
        createdAt: LessThanOrEqual(createdBefore.toISOString()),
      },
      order: { createdAt: "ASC", sequence: "ASC" },
      take: 10,
      loadEagerRelations: false,
    });
    return records.map(({ id, ownerId, createdAt }) => ({
      id,
      ownerId,
      createdAt,
    }));
  }

  /** Recheck owner, unread, and pending state under a row lock, and commit the claim before inference. */
  async claimSummary(
    scope: OwnerScope,
    id: string,
  ): Promise<UpdateSummaryInput | undefined> {
    const where: FindOptionsWhere<UpdateRecord> = {
      ...this.scopeWhere(scope),
      id,
      readAt: IsNull(),
      summaryStatus: "pending",
    };
    return serializableTransaction(this.orm.manager, async (manager) => {
      const repository = manager.getRepository(UpdateEntity);
      const record = await repository.findOne({
        where,
        relations: { agent: true },
        lock: { mode: "pessimistic_write", tables: ["updates"] },
      });
      if (!record) return undefined;
      await repository.update(where, {
        summaryStatus: "generating",
        summaryStartedAt: new Date().toISOString(),
      });
      const update = this.toEntity(record);
      return {
        id: update.id,
        ownerId: update.ownerId,
        createdAt: update.createdAt,
        kind: update.kind,
        text: update.sourceText,
        inference: record.agent?.inference ?? null,
      };
    });
  }

  /** Only the claimed attempt can finish, so a duplicate result never overwrites the first. */
  async finishSummary(
    scope: OwnerScope,
    id: string,
    summary: string | null,
  ): Promise<void> {
    await this.orm.update(
      { ...this.scopeWhere(scope), id, summaryStatus: "generating" },
      { summary, summaryStatus: summary === null ? "failed" : "ready" },
    );
  }

  // ===========================================
  // Domain policy
  // ===========================================

  /** Updates are directly owned, so every query filters by their owner column. */
  protected scopeWhere({
    ownerId,
  }: OwnerScope): FindOptionsWhere<UpdateRecord> {
    if (!ownerId) throw new Error("Update storage requires an owner");
    return { ownerId };
  }

  /** Resolve each kind's source; check constraints guarantee its references are present. */
  protected toEntity(record: UpdateRecord): StoredUpdate {
    const shared = {
      id: record.id,
      ownerId: record.ownerId,
      createdAt: record.createdAt,
      summary: record.summary,
      summaryStatus: record.summaryStatus,
      summaryStartedAt: record.summaryStartedAt,
      readAt: record.readAt,
    };
    switch (record.kind) {
      case "message":
        return {
          ...shared,
          kind: "message",
          agentId: record.agentId!,
          messageId: record.messageId!,
          sourceText: record.message!.text,
        };
    }
  }
}
