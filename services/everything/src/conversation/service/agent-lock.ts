import AsyncLock from "async-lock";

/** Adapt the established keyed lock to the main-agent lifecycle. */
export class AgentLock {
  // ===========================================
  // State
  // ===========================================

  private readonly lock = new AsyncLock();

  // ===========================================
  // Operations
  // ===========================================

  /** Serialize one agent's work while allowing unrelated agents to proceed concurrently. */
  run<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    return this.lock.acquire(agentId, operation);
  }
}
