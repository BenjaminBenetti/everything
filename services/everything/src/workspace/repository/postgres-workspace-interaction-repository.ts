import { randomUUID } from "node:crypto";
import type { DataSource, FindOptionsWhere } from "typeorm";
import {
  BaseRepository,
  type ListOptions,
} from "@everything/persistence/repository";
import { serializableTransaction } from "@everything/persistence/transaction";
import type { WorkspaceReference } from "@everything/workspace-contracts/instance";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type {
  WorkspaceActivityScope,
  WorkspaceInteractionRepository,
} from "../interface/workspace-activity.js";
import type {
  WorkspaceInteraction,
  WorkspaceInteractionRecord,
} from "../model/workspace-interaction.js";
import { WorkspaceInteractionEntity } from "../schema/workspace-interaction-entity.js";

/** Persist teammate-scoped recency while keeping concurrent forks from duplicating a workspace. */
export class PostgresWorkspaceInteractionRepository
  extends BaseRepository<
    WorkspaceInteraction,
    WorkspaceActivityScope,
    WorkspaceInteractionRecord
  >
  implements WorkspaceInteractionRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Accept listing policy from the workspace activity service's composition root. */
  constructor(
    database: DataSource,
    listing: ListOptions<WorkspaceInteractionRecord>,
  ) {
    super(database.getRepository(WorkspaceInteractionEntity), listing);
  }

  // ===========================================
  // Persistence
  // ===========================================

  /** Serialize updates through the owning teammate and ignore delayed, older timestamps. */
  async touch(
    scope: WorkspaceActivityScope,
    workspace: WorkspaceReference,
    at: string,
  ): Promise<void> {
    await serializableTransaction(this.orm.manager, async (manager) => {
      const agent = await manager.getRepository(AgentEntity).findOne({
        where: { id: scope.agentId, ownerId: scope.ownerId },
        lock: { mode: "pessimistic_write" },
      });
      if (!agent) throw new AgentNotFoundError();
      const repository = manager.getRepository(WorkspaceInteractionEntity);
      const previous = await repository.findOneBy({
        ...this.scopeWhere(scope),
        ...workspace,
      });
      if (previous && Date.parse(previous.lastInteractedAt) >= Date.parse(at))
        return;
      await repository.save(
        repository.create({
          ...previous,
          id: previous?.id ?? randomUUID(),
          agentId: scope.agentId,
          ...workspace,
          lastInteractedAt: at,
        }),
      );
    });
  }

  /** Apply ownership and teammate identity in every ORM lookup. */
  protected scopeWhere({
    ownerId,
    agentId,
  }: WorkspaceActivityScope): FindOptionsWhere<WorkspaceInteractionRecord> {
    return { agentId, agent: { ownerId } };
  }

  /** Keep foreign keys and relation metadata out of the domain projection. */
  protected toEntity({
    id,
    createdAt,
    type,
    name,
    lastInteractedAt,
  }: WorkspaceInteractionRecord): WorkspaceInteraction {
    return { id, createdAt, type, name, lastInteractedAt };
  }
}
