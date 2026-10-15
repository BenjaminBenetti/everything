import type { BaseEntity } from "@everything/persistence/entity";
import type { WorkspaceReference } from "@everything/workspace-contracts/instance";
import type { AgentDefinition } from "../../agent/model/agent.js";

/** Persist one last-use timestamp per teammate and workspace, independent of runtime sessions. */
export interface WorkspaceInteraction extends BaseEntity, WorkspaceReference {
  readonly lastInteractedAt: string;
}

/** Ownership follows the teammate relation and is never supplied by a tool argument. */
export interface WorkspaceInteractionRecord extends WorkspaceInteraction {
  readonly agentId: string;
  readonly agent?: AgentDefinition;
}
