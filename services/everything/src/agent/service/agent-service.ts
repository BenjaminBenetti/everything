import { AgentNotFoundError } from "../error/agent-errors.js";
import type { AgentCatalog } from "../interface/agent-catalog.js";
import type { AgentRepository } from "../interface/agent-repository.js";
import type { AgentDefinition, CreateAgentInput } from "../model/agent.js";

/** Owns agent definition use cases, independently of HTTP and database details. */
export class AgentService implements AgentCatalog {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive the persistence boundary through dependency injection. */
  constructor(private readonly repository: AgentRepository) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Return only definitions owned by the authenticated identity. */
  list(ownerId: string): Promise<AgentDefinition[]> {
    return this.repository.list({ ownerId });
  }

  /** Create a user-named agent in an available persistent workspace. */
  create(ownerId: string, input: CreateAgentInput): Promise<AgentDefinition> {
    return this.repository.create(
      { ownerId },
      {
        name: input.name,
        systemPrompt: input.systemPrompt,
        ...(input.avatarId !== undefined ? { avatarId: input.avatarId } : {}),
      },
    );
  }

  /** Hide both missing agents and agents owned by a different identity. */
  async get(ownerId: string, id: string): Promise<AgentDefinition> {
    const agent = await this.repository.getById({ ownerId }, id);
    if (!agent) throw new AgentNotFoundError();
    return agent;
  }

  /** Remove a definition; the caller must first stop its runtime. */
  async delete(ownerId: string, id: string): Promise<void> {
    await this.get(ownerId, id);
    await this.repository.delete({ ownerId }, id);
  }
}
