import type { OwnerScope } from "@everything/persistence/repository";
import type { AgentDefinition } from "../model/agent.js";

/** Narrow persistence contract for changing only a saved agent's name. */
export interface AgentNameStore {
  /** Update the scoped record and return it, or undefined when inaccessible. */
  rename(
    scope: OwnerScope,
    id: string,
    name: string,
  ): Promise<AgentDefinition | undefined>;
}
