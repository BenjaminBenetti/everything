import type { AgentAvatarId } from "./avatar.js";
import type { InferenceSelection } from "@everything/provider-contracts/inference";
import type { EffectiveModel } from "@everything/provider-contracts/inference";

/**
 * Why the saved selection couldn't be checked: `settings` when the provider's model list no longer
 * offers its model, effort, or speed, so the owner needs to choose again; `provider` when the
 * connection or its model list couldn't be reached, which says nothing about the model.
 */
export type AgentSelectionIssue = "settings" | "provider";

/** Fresh saved-selection metadata and the independently pinned runtime, if loaded. */
export interface AgentModelInfo {
  readonly selected: EffectiveModel | null;
  readonly applied: EffectiveModel | null;
  /** The saved selection couldn't be checked; applied metadata remains available independently. */
  readonly selectionError: boolean;
  /** Present with `selectionError`; servers before it was added omit it. */
  readonly selectionIssue?: AgentSelectionIssue;
}

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
