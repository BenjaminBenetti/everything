import { AgentNotFoundError } from "../error/agent-errors.js";
import type { AgentEditing } from "../interface/agent-editing.js";
import type { AgentProfileStore } from "../interface/agent-profile-store.js";
import type { AgentDefinition, UpdateAgentInput } from "../model/agent.js";
import type { ProviderModels } from "../../provider/interface/provider-models.js";

/** Owns profile editing policy without starting or modifying a conversation. */
export class AgentEditingService implements AgentEditing {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive only scoped profile storage and inference validation. */
  constructor(
    private readonly profiles: AgentProfileStore,
    private readonly models: Pick<ProviderModels, "validate">,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Verify ownership and any new inference selection before applying profile changes. */
  async update(
    ownerId: string,
    id: string,
    input: UpdateAgentInput,
  ): Promise<AgentDefinition> {
    if (!(await this.profiles.getById({ ownerId }, id)))
      throw new AgentNotFoundError();
    if (input.inference) await this.models.validate(ownerId, input.inference);
    const changes: UpdateAgentInput = {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.systemPrompt !== undefined
        ? { systemPrompt: input.systemPrompt.trim() }
        : {}),
      ...(input.avatarId !== undefined ? { avatarId: input.avatarId } : {}),
      ...(input.inference ? { inference: input.inference } : {}),
    };
    const agent = await this.profiles.update({ ownerId }, id, changes);
    if (!agent) throw new AgentNotFoundError();
    return agent;
  }
}
