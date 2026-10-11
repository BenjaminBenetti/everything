import { AgentNotFoundError } from "../error/agent-errors.js";
import type { AgentNaming } from "../interface/agent-naming.js";
import type { AgentNameStore } from "../interface/agent-name-store.js";
import type { AgentDefinition } from "../model/agent.js";

/** Owns naming policy without coupling name changes to the agent runtime. */
export class AgentNamingService implements AgentNaming {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive only the persistence operation this use case needs. */
  constructor(private readonly names: AgentNameStore) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Preserve the lookup policy for missing and inaccessible definitions. */
  async rename(
    ownerId: string,
    id: string,
    name: string,
  ): Promise<AgentDefinition> {
    const agent = await this.names.rename({ ownerId }, id, name.trim());
    if (!agent) throw new AgentNotFoundError();
    return agent;
  }
}
