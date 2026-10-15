import type { ListOptions } from "@everything/persistence/repository";
import type { AgentActivity } from "../interface/agent-activity.js";
import type { AgentActivityStore } from "../interface/agent-activity-repository.js";
import type { AgentDefinition } from "../model/agent.js";
import type { AgentRecord } from "../model/agent-record.js";

/** Show three distinct teammates, newest interaction first, with stable ordering for ties. */
export const recentAgentListing: ListOptions<AgentRecord> = {
  order: { lastInteractedAt: "DESC", id: "DESC" },
  take: 3,
};

/** Own recency policy without treating background replies or polling as user interaction. */
export class AgentActivityService implements AgentActivity {
  // ===========================================
  // Construction
  // ===========================================

  /** Keep storage and the server clock independently replaceable. */
  constructor(
    private readonly activity: AgentActivityStore,
    private readonly now: () => number = Date.now,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read only the owner's recent teammates without renewing their activity. */
  recent(ownerId: string): Promise<AgentDefinition[]> {
    return this.activity.list({ ownerId });
  }

  /** Record an interaction using trusted server time and the authenticated owner. */
  touch(ownerId: string, agentId: string): Promise<void> {
    return this.activity.touch(
      { ownerId },
      agentId,
      new Date(this.now()).toISOString(),
    );
  }
}
