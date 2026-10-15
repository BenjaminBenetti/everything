/** Lifecycle states reported by the workspace runtime. */
export const workspaceStatuses = [
  "creating",
  "cloning",
  "running",
  "stopped",
  "failed",
  "stopping",
  "starting",
  "deleting",
  "rebuilding",
  "unknown",
] as const;

export type WorkspaceStatus = (typeof workspaceStatuses)[number];

/** Limits for the names used to address existing workspace instances. */
export const workspaceInstanceLimits = { nameLength: 255 };

/** An instance is unique within its type, which corresponds to a Fleet fleet. */
export interface WorkspaceReference {
  readonly type: string;
  readonly name: string;
}

/** Current measured usage; null means a measurement is unavailable. */
export interface WorkspaceResources {
  readonly cpuCores: number | null;
  readonly memoryBytes: number | null;
}

/** The public view of an instance, without runtime paths or credentials. */
export interface WorkspaceInstance extends WorkspaceReference {
  readonly status: WorkspaceStatus;
  readonly resources: WorkspaceResources;
}

/** Envelope returned by the workspace directory. */
export interface WorkspaceInstanceList {
  readonly workspaces: readonly WorkspaceInstance[];
}
