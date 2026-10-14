import type { WorkerSettings } from "@everything/settings-contracts";

/** The workspace's worker settings, which every teammate's workers follow. */
export interface WorkerSettingsOperations {
  /** The current settings. */
  read(): Promise<WorkerSettings>;
  /** Apply new settings and return them as they now stand. */
  update(settings: WorkerSettings): Promise<WorkerSettings>;
}
