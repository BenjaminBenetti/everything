import { IsNull, Not, type DataSource, type FindOptionsWhere } from "typeorm";
import { BaseRepository } from "@everything/persistence/repository";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { WorkspaceTargetRepository } from "../interface/workspace-target-repository.js";
import type {
  WorkspaceTarget,
  WorkspaceTargetScope,
} from "../model/workspace-target.js";

/** Read desired pod identities using the same durable records as the teammate directory. */
export class PostgresWorkspaceTargetRepository
  extends BaseRepository<WorkspaceTarget, WorkspaceTargetScope, AgentDefinition>
  implements WorkspaceTargetRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Reuse mapped ORM defaults and deterministic listing order. */
  constructor(database: DataSource) {
    super(database.getRepository(AgentEntity), {
      order: { createdAt: "ASC", id: "ASC" },
    });
  }

  /** Internal maintenance includes every owned record, independent of application/database clock skew. */
  protected scopeWhere({
    ownership,
  }: WorkspaceTargetScope): FindOptionsWhere<AgentDefinition> {
    if (ownership !== "all")
      throw new Error(
        "Workspace reconciliation requires an explicit ownership scope",
      );
    return { ownerId: Not(IsNull()) };
  }

  /** Expose identifiers only; model credentials and instructions never enter pod specifications. */
  protected toEntity(record: AgentDefinition): WorkspaceTarget {
    return {
      id: record.id,
      ownerId: record.ownerId,
      createdAt: record.createdAt,
    };
  }
}
