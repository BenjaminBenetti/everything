import { AgentNotFoundError } from "../error/agent-errors.js";
import type { AgentEditing } from "../interface/agent-editing.js";
import type { AgentProfileStore } from "../interface/agent-profile-store.js";
import type { AgentDefinition, UpdateAgentInput } from "../model/agent.js";

/** Owns profile editing policy without starting or modifying a conversation. */
export class AgentEditingService implements AgentEditing {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive only the persistence operation this use case needs. */
  constructor(private readonly profiles: AgentProfileStore) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Preserve the lookup policy for missing and inaccessible definitions. */
  async update(
    ownerId: string,
    id: string,
    input: UpdateAgentInput,
  ): Promise<AgentDefinition> {
    const changes: UpdateAgentInput = {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.systemPrompt !== undefined
        ? { systemPrompt: input.systemPrompt.trim() }
        : {}),
      ...(input.avatarId !== undefined ? { avatarId: input.avatarId } : {}),
    };
    const agent = await this.profiles.update({ ownerId }, id, changes);
    if (!agent) throw new AgentNotFoundError();
    return agent;
  }
}
