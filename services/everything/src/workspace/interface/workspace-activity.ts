import type {
  OwnerScope,
  Repository,
} from "@everything/persistence/repository";
import type { RecentWorkspaceList } from "@everything/workspace-contracts/activity";
import type {
  WorkspaceReference,
  WorkspaceStatus,
} from "@everything/workspace-contracts/instance";
import type { WorkspaceInteraction } from "../model/workspace-interaction.js";

/** Every interaction belongs to a saved teammate, including interactions from its private forks. */
export interface WorkspaceActivityScope extends OwnerScope {
  readonly agentId: string;
}

/** Durable timestamps with inherited, scoped lookups and listing. */
export interface WorkspaceInteractionRepository extends Repository<
  WorkspaceInteraction,
  WorkspaceActivityScope
> {
  /** Insert or advance one timestamp without overwriting a newer concurrent interaction. */
  touch(
    scope: WorkspaceActivityScope,
    workspace: WorkspaceReference,
    at: string,
  ): Promise<void>;
}

/** The runtime only records activity; it cannot read other teammates' recent workspaces. */
export interface WorkspaceActivityRecorder {
  /** Record an explicit interaction using the identity bound by the session factory. */
  touch(
    scope: WorkspaceActivityScope,
    workspace: WorkspaceReference,
  ): Promise<void>;
}

/** Read a bounded, authorized conversation overview with current runtime state. */
export interface WorkspaceActivityReader {
  /** Resolve the teammate's most recently used workspaces in descending interaction order. */
  recent(scope: WorkspaceActivityScope): Promise<RecentWorkspaceList>;
}

/** Read lifecycle state without collecting CPU and memory metrics for the chat overview. */
export interface WorkspaceStates {
  /** Read existing workspace identities and their authoritative lifecycle states. */
  states(): Promise<
    readonly (WorkspaceReference & { readonly status: WorkspaceStatus })[]
  >;
}
