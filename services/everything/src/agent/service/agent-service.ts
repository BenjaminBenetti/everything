import { AgentNotFoundError } from "../error/agent-errors.js";
import type { AgentCatalog } from "../interface/agent-catalog.js";
import type { AgentRepository } from "../interface/agent-repository.js";
import type { AgentDefinition, CreateAgentInput } from "../model/agent.js";
import type { ProviderModels } from "../../provider/interface/provider-models.js";

/** Owns agent definition use cases, independently of HTTP and database details. */
export class AgentService implements AgentCatalog {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive persistence and owner-scoped inference validation through dependency injection. */
  constructor(
    private readonly repository: AgentRepository,
    private readonly models: Pick<ProviderModels, "validate">,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Return only definitions owned by the authenticated identity. */
  list(ownerId: string): Promise<AgentDefinition[]> {
    return this.repository.list({ ownerId });
  }

  /** Create a teammate profile after validating its optional inference selection. */
  async create(
    ownerId: string,
    input: CreateAgentInput,
  ): Promise<AgentDefinition> {
    if (input.inference) await this.models.validate(ownerId, input.inference);
    return this.repository.create(
      { ownerId },
      {
        name: input.name,
        systemPrompt: input.systemPrompt,
        ...(input.avatarId !== undefined ? { avatarId: input.avatarId } : {}),
        ...(input.inference ? { inference: input.inference } : {}),
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
