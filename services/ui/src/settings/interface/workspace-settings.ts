import type {
  GeneralSettings,
  WorkerSettings,
} from "@everything/settings-contracts";

/** The settings that apply to the whole workspace, independent of HTTP. */
export interface WorkspaceSettings {
  /** Read the signed-in owner's general preferences. */
  general(signal?: AbortSignal): Promise<GeneralSettings>;
  /** Save general preferences across the owner's devices. */
  updateGeneral(settings: GeneralSettings): Promise<GeneralSettings>;
  /** Read how teammates' workers are set up. */
  workers(signal?: AbortSignal): Promise<WorkerSettings>;
  /** Change how teammates' workers are set up, returning the settings as they now stand. */
  updateWorkers(settings: WorkerSettings): Promise<WorkerSettings>;
}
