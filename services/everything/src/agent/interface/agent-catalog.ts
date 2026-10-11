import type { AgentDefinition, CreateAgentInput } from "../model/agent.js";

/** Agent definition use cases, always scoped to the authenticated subject. */
export interface AgentCatalog {
  /** List saved definitions for the authenticated subject. */
  list(ownerId: string): Promise<AgentDefinition[]>;
  /** Create a definition and reserve its persistent workspace. */
  create(ownerId: string, input: CreateAgentInput): Promise<AgentDefinition>;
  /** Resolve a definition owned by the subject, or report it missing. */
  get(ownerId: string, id: string): Promise<AgentDefinition>;
  /** Remove a definition whose runtime has already stopped; transports use AgentRemoval instead. */
  delete(ownerId: string, id: string): Promise<void>;
}
