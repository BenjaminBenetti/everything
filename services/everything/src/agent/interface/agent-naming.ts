import type { AgentDefinition } from "../model/agent.js";

/** Name changes are independent of conversation execution. */
export interface AgentNaming {
  /** Rename an owned definition, reporting missing and foreign IDs identically. */
  rename(ownerId: string, id: string, name: string): Promise<AgentDefinition>;
}
