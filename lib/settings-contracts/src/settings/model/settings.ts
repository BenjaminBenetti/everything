/** Preferences for the signed-in owner's workspace, shared across their devices. */
export interface GeneralSettings {
  /** Whether update cards use model-generated summaries instead of message previews. */
  readonly summarizeUpdates: boolean;
}

/** Generate summaries only after the owner enables them. */
export const defaultGeneralSettings: GeneralSettings = Object.freeze({
  summarizeUpdates: false,
});

/** The order the signed-in owner arranged their teammates in, shared across their devices. */
export interface TeammateOrder {
  /** Teammate IDs, first to last; teammates missing from the list follow in creation order. */
  readonly teammateIds: readonly string[];
}

/** Owners who never rearrange their team see teammates in creation order. */
export const defaultTeammateOrder: TeammateOrder = Object.freeze({
  teammateIds: Object.freeze([]),
});

/** Public teammate order limits shared by HTTP validation and browser saves. */
export const teammateOrderLimits = {
  teammateCount: 1000,
} as const;

/** How the workers that teammates run their work in are set up, for the whole workspace. */
export interface WorkerSettings {
  /** Whether workers may run privileged, which Docker inside a worker needs. */
  readonly privileged: boolean;
}
