/** Each agent's private working directory for notes, files, and its Pi session. */
export interface AgentWorkspaces {
  /** Absolute path of the folder every agent can read and write. */
  readonly shared: string;
  /** Absolute path of the agent's working directory, which may not exist yet. */
  directory(agentId: string): string;
  /** Delete the agent's working directory and its contents; a missing directory is ignored. */
  remove(agentId: string): Promise<void>;
}
