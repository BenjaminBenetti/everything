import { randomUUID } from "node:crypto";
import { defaultAgentAvatarId } from "@everything/agent-contracts/avatar";
import type { DataSource, FindOptionsWhere } from "typeorm";
import {
  BaseRepository,
  type OwnerScope,
} from "@everything/persistence/repository";
import type { AgentRepository } from "../interface/agent-repository.js";
import type { AgentProfileStore } from "../interface/agent-profile-store.js";
import type {
  AgentDefinition,
  CreateAgentInput,
  UpdateAgentInput,
} from "../model/agent.js";
import { AgentEntity } from "../schema/agent-entity.js";

/** Persist mapped agent definitions, scoped to their owner. */
export class PostgresAgentRepository
  extends BaseRepository<AgentDefinition, OwnerScope>
  implements AgentRepository, AgentProfileStore
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the ORM repository with oldest-first listings. */
  constructor(database: DataSource) {
    super(database.getRepository(AgentEntity), {
      order: { createdAt: "ASC", id: "ASC" },
    });
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Save a new definition owned by the scope. */
  async create(
    { ownerId }: OwnerScope,
    agent: CreateAgentInput,
  ): Promise<AgentDefinition> {
    return this.orm.save(
      this.orm.create({
        id: randomUUID(),
        ownerId,
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        avatarId: agent.avatarId ?? defaultAgentAvatarId,
        inference: agent.inference ?? null,
      }),
    );
  }

  /** Apply ownership to the update itself and leave omitted fields untouched. */
  async update(
    scope: OwnerScope,
    id: string,
    input: UpdateAgentInput,
  ): Promise<AgentDefinition | undefined> {
    if (!scope.ownerId || !id)
      throw new Error("Editing requires an owner and agent identifier");
    const result = await this.orm.update(
      { ...this.scopeWhere(scope), id },
      input,
    );
    return result.affected ? this.getById(scope, id) : undefined;
  }

  // ===========================================
  // Domain policy
  // ===========================================

  /** Apply verified ownership to every inherited ORM operation. */
  protected scopeWhere({
    ownerId,
  }: OwnerScope): FindOptionsWhere<AgentDefinition> {
    return { ownerId };
  }

  /** Definitions contain no persistence-only relation fields. */
  protected toEntity(record: AgentDefinition): AgentDefinition {
    return record;
  }
}
