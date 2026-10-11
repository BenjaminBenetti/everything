import type { OwnedEntity } from "@everything/persistence/entity";

/** Inclusive maximum lengths shared by request validation and database checks. */
export const agentLimits = {
  nameLength: 80,
  systemPromptLength: 16000,
} as const;

/** User-supplied fields for creating an agent. */
export interface CreateAgentInput {
  readonly name: string;
  readonly systemPrompt: string;
}

/** A saved, user-named agent; its files live in a directory named by its ID. */
export interface AgentDefinition extends OwnedEntity {
  readonly name: string;
  readonly systemPrompt: string;
}
