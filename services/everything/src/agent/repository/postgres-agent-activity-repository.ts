import {
  IsNull,
  LessThan,
  Not,
  Or,
  type DataSource,
  type FindOptionsWhere,
} from "typeorm";
import {
  BaseRepository,
  type ListOptions,
  type OwnerScope,
} from "@everything/persistence/repository";
import type { AgentActivityRepository } from "../interface/agent-activity-repository.js";
import type { AgentRecord } from "../model/agent-record.js";
import { AgentEntity } from "../schema/agent-entity.js";
import { AgentNotFoundError } from "../error/agent-errors.js";

/** Store recency on the teammate so deleting a profile also removes it from recent listings. */
export class PostgresAgentActivityRepository
  extends BaseRepository<AgentRecord, OwnerScope>
  implements AgentActivityRepository
{
  // ===========================================
  // Construction
  // ===========================================

  /** Receive the owning service's ordering and limit policy. */
  constructor(database: DataSource, listing: ListOptions<AgentRecord>) {
    super(database.getRepository(AgentEntity), listing);
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Atomically advance recency; missing and inaccessible teammates have the same response. */
  async touch(scope: OwnerScope, agentId: string, at: string): Promise<void> {
    if (!agentId || !Number.isFinite(Date.parse(at)))
      throw new Error("Interaction requires a teammate and timestamp");
    const where = { ...this.ownerWhere(scope), id: agentId };
    const result = await this.orm.update(
      { ...where, lastInteractedAt: Or(IsNull(), LessThan(at)) },
      { lastInteractedAt: at },
    );
    if (!result.affected && !(await this.orm.existsBy(where)))
      throw new AgentNotFoundError();
  }

  // ===========================================
  // Domain mapping
  // ===========================================

  /** Only explicitly interacted-with teammates belong in recent listings. */
  protected scopeWhere(scope: OwnerScope): FindOptionsWhere<AgentRecord> {
    return { ...this.ownerWhere(scope), lastInteractedAt: Not(IsNull()) };
  }

  /** Preserve the internal metadata; the HTTP presenter exposes only teammate fields. */
  protected toEntity(record: AgentRecord): AgentRecord {
    return record;
  }

  /** Refuse omitted ownership before reading or updating a teammate. */
  private ownerWhere({ ownerId }: OwnerScope): FindOptionsWhere<AgentRecord> {
    if (!ownerId) throw new Error("Teammate activity requires an owner");
    return { ownerId };
  }
}
