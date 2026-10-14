import type { WorkerSettings } from "@everything/settings-contracts";

/** The settings that apply to the whole workspace, independent of HTTP. */
export interface WorkspaceSettings {
  /** Read how teammates' workers are set up. */
  workers(signal?: AbortSignal): Promise<WorkerSettings>;
  /** Change how teammates' workers are set up, returning the settings as they now stand. */
  updateWorkers(settings: WorkerSettings): Promise<WorkerSettings>;
}
