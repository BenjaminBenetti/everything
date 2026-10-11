import type {
  OwnerScope,
  Repository,
} from "@everything/persistence/repository";
import type { AgentDefinition, CreateAgentInput } from "../model/agent.js";

/** Persistence boundary for agent definitions. */
export interface AgentRepository extends Repository<
  AgentDefinition,
  OwnerScope
> {
  /** List the caller's saved agent definitions, oldest first. */
  list(scope: OwnerScope): Promise<AgentDefinition[]>;
  /** Persist a new agent owned by the scope. */
  create(scope: OwnerScope, agent: CreateAgentInput): Promise<AgentDefinition>;
}
