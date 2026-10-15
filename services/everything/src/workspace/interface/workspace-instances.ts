import type {
  WorkspaceInstance,
  WorkspaceReference,
} from "@everything/workspace-contracts/instance";

/** The shared workspaces managed by teammates in this installation. */
export interface WorkspaceInstances {
  /** List existing instances and their current resource usage. */
  list(): Promise<readonly WorkspaceInstance[]>;
  /** Resume an existing stopped instance. */
  start(workspace: WorkspaceReference): Promise<void>;
  /** Stop a running instance while retaining its files. */
  stop(workspace: WorkspaceReference): Promise<void>;
  /** Begin removing a stopped instance and its saved files. */
  delete(workspace: WorkspaceReference): Promise<void>;
}
