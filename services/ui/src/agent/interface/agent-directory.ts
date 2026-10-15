import type {
  Agent,
  CreateAgentInput,
  UpdateAgentInput,
} from "@everything/agent-contracts";

/** The UI can manage definitions without gaining any conversation operations. */
export interface AgentDirectory {
  /** List the authenticated user's saved definitions. */
  list(signal?: AbortSignal): Promise<Agent[]>;
  /** Read the owner's three most recently opened or messaged teammates. */
  recent(signal?: AbortSignal): Promise<Agent[]>;
  /** Record opening an existing teammate without starting model work. */
  touch(id: string): Promise<void>;
  /** Persist a new named definition. */
  create(input: CreateAgentInput): Promise<Agent>;
  /** Save the chosen teammate's editable profile without starting work. */
  update(id: string, input: UpdateAgentInput): Promise<Agent>;
  /** Permanently remove the chosen teammate and their saved data. */
  delete(id: string): Promise<void>;
}
