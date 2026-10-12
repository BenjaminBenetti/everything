import type { OwnedEntity } from "@everything/persistence/entity";
import type { AgentAvatarId } from "@everything/agent-contracts/avatar";
import type { InferenceSelection } from "@everything/provider-contracts/inference";
export {
  agentLimits,
  type CreateAgentInput,
  type UpdateAgentInput,
} from "@everything/agent-contracts";

/** A saved, user-named agent; its files live in a directory named by its ID. */
export interface AgentDefinition extends OwnedEntity {
  readonly name: string;
  readonly systemPrompt: string;
  readonly avatarId: AgentAvatarId;
  readonly inference: InferenceSelection | null;
}
