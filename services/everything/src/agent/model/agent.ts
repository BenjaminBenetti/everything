import type { OwnedEntity } from "@everything/persistence/entity";
export {
  agentLimits,
  type CreateAgentInput,
} from "@everything/agent-contracts";

/** A saved, user-named agent; its files live in a directory named by its ID. */
export interface AgentDefinition extends OwnedEntity {
  readonly name: string;
  readonly systemPrompt: string;
}
