/** Deletes an agent safely by stopping its runtime work before removing its records. */
export interface AgentRemoval {
  /** Stop the agent's runtime, then delete its definition and visible messages. */
  delete(ownerId: string, agentId: string): Promise<void>;
}
