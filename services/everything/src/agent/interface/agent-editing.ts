import type { AgentDefinition, UpdateAgentInput } from "../model/agent.js";

/** Saved profile changes are independent of conversation execution. */
export interface AgentEditing {
  /** Edit an owned definition, reporting missing and foreign IDs identically. */
  update(
    ownerId: string,
    id: string,
    input: UpdateAgentInput,
  ): Promise<AgentDefinition>;
}
