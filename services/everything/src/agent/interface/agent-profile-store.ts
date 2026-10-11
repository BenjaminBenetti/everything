import type { OwnerScope } from "@everything/persistence/repository";
import type { AgentDefinition, UpdateAgentInput } from "../model/agent.js";

/** Narrow persistence contract for changing a saved profile. */
export interface AgentProfileStore {
  /** Update the scoped record and return it, or undefined when inaccessible. */
  update(
    scope: OwnerScope,
    id: string,
    input: UpdateAgentInput,
  ): Promise<AgentDefinition | undefined>;
}
