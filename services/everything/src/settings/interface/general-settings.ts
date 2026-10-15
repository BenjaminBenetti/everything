import type { GeneralSettings } from "@everything/settings-contracts";

/** Read only the preferences belonging to an authenticated owner. */
export interface GeneralSettingsReader {
  /** Return saved preferences or the defaults when none have been saved. */
  read(ownerId: string): Promise<GeneralSettings>;
}

/** Change the signed-in owner's general preferences. */
export interface GeneralSettingsOperations extends GeneralSettingsReader {
  /** Save the owner's preferences and return the saved values. */
  update(ownerId: string, settings: GeneralSettings): Promise<GeneralSettings>;
}
