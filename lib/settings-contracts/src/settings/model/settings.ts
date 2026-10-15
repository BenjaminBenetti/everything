/** Preferences for the signed-in owner's workspace, shared across their devices. */
export interface GeneralSettings {
  /** Whether update cards use model-generated summaries instead of message previews. */
  readonly summarizeUpdates: boolean;
}

/** Generate summaries only after the owner enables them. */
export const defaultGeneralSettings: GeneralSettings = Object.freeze({
  summarizeUpdates: false,
});

/** How the workers that teammates run their work in are set up, for the whole workspace. */
export interface WorkerSettings {
  /** Whether workers may run privileged, which Docker inside a worker needs. */
  readonly privileged: boolean;
}
