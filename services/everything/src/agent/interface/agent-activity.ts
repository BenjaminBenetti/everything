import type { AgentDefinition } from "../model/agent.js";

/** User interactions with teammates, independent of model work and conversation polling. */
export interface AgentActivity {
  /** Return the owner's three most recently opened or messaged teammates. */
  recent(ownerId: string): Promise<AgentDefinition[]>;
  /** Record an explicit interaction with an owned teammate using server time. */
  touch(ownerId: string, agentId: string): Promise<void>;
}
