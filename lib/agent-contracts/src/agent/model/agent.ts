import type { AgentAvatarId } from "./avatar.js";
import type { InferenceSelection } from "@everything/provider-contracts/inference";

/** Public agent field limits shared by HTTP validation and browser forms. */
export const agentLimits = {
  nameLength: 80,
  systemPromptLength: 16000,
} as const;

/** Input for creating an agent definition without starting a conversation. */
export interface CreateAgentInput {
  readonly name: string;
  readonly systemPrompt: string;
  readonly avatarId?: AgentAvatarId;
  readonly inference?: InferenceSelection;
}

/** Public representation; ownership and storage details remain in the API. */
export interface Agent extends Omit<CreateAgentInput, "inference"> {
  readonly id: string;
  readonly avatarId: AgentAvatarId;
  readonly createdAt: string;
  readonly inference: InferenceSelection | null;
}

/** Partial changes to a saved profile; omitted fields retain their values. */
export interface UpdateAgentInput {
  readonly inference?: InferenceSelection;
  readonly name?: string;
  readonly systemPrompt?: string;
  readonly avatarId?: AgentAvatarId;
}

/** Envelope returned by the agent directory endpoint. */
export interface AgentList {
  readonly agents: Agent[];
}
