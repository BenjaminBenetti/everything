import type { Agent, CreateAgentInput } from "@everything/agent-contracts";

/** The UI can manage definitions without gaining any conversation operations. */
export interface AgentDirectory {
  /** List the authenticated user's saved definitions. */
  list(signal?: AbortSignal): Promise<Agent[]>;
  /** Persist a new named definition. */
  create(input: CreateAgentInput): Promise<Agent>;
  /** Change only the chosen agent's name. */
  rename(id: string, name: string): Promise<Agent>;
}
