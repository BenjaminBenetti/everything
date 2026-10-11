/** Public agent field limits shared by HTTP validation and browser forms. */
export const agentLimits = {
  nameLength: 80,
  systemPromptLength: 16000,
} as const;

/** Input for creating an agent definition without starting a conversation. */
export interface CreateAgentInput {
  readonly name: string;
  readonly systemPrompt: string;
}

/** Public representation; ownership and storage details remain in the API. */
export interface Agent extends CreateAgentInput {
  readonly id: string;
  readonly createdAt: string;
}

/** Rename input deliberately excludes runtime and prompt changes. */
export interface RenameAgentInput {
  readonly name: string;
}

/** Envelope returned by the agent directory endpoint. */
export interface AgentList {
  readonly agents: Agent[];
}
