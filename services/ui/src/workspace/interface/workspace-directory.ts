import type {
  WorkspaceInstance,
  WorkspaceReference,
} from "@everything/workspace-contracts/instance";
import type { RecentWorkspaceList } from "@everything/workspace-contracts/activity";

/** The conversation overview needs only the current teammate's recent workspace activity. */
export interface WorkspaceActivityReader {
  /** Read distinct recent workspaces with live state and teammate-specific activity timestamps. */
  recent(agentId: string, signal?: AbortSignal): Promise<RecentWorkspaceList>;
}

/** The workspace directory and lifecycle controls, independent of HTTP. */
export interface WorkspaceDirectory extends WorkspaceActivityReader {
  /** List shared instances, cancelling when the page no longer needs the result. */
  list(signal?: AbortSignal): Promise<readonly WorkspaceInstance[]>;
  /** Start a stopped instance. */
  start(workspace: WorkspaceReference): Promise<void>;
  /** Stop a running instance and retain its saved files. */
  stop(workspace: WorkspaceReference): Promise<void>;
  /** Begin deleting a stopped instance and its saved files. */
  delete(workspace: WorkspaceReference): Promise<void>;
}
