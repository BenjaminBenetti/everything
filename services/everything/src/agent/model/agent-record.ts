import type { AgentDefinition } from "./agent.js";

/** Persist interaction metadata separately from the teammate's editable definition. */
export interface AgentRecord extends AgentDefinition {
  readonly lastInteractedAt: string | null;
}
