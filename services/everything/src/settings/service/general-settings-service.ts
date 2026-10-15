import {
  defaultGeneralSettings,
  type GeneralSettings,
} from "@everything/settings-contracts";
import type { GeneralSettingsOperations } from "../interface/general-settings.js";
import type { GeneralSettingsStore } from "../interface/general-settings-repository.js";

/** Own defaults and persistence for the signed-in owner's general preferences. */
export class GeneralSettingsService implements GeneralSettingsOperations {
  // ===========================================
  // Construction
  // ===========================================

  /** Accept only the settings storage operations this service needs. */
  constructor(private readonly settings: GeneralSettingsStore) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read without creating a record, keeping summaries off until the owner opts in. */
  async read(ownerId: string): Promise<GeneralSettings> {
    const [saved] = await this.settings.list({ ownerId });
    return {
      summarizeUpdates:
        saved?.summarizeUpdates ?? defaultGeneralSettings.summarizeUpdates,
    };
  }

  /** Save only the current owner's preference and exclude persistence metadata from the response. */
  async update(
    ownerId: string,
    settings: GeneralSettings,
  ): Promise<GeneralSettings> {
    await this.settings.save({ ownerId }, settings);
    return { summarizeUpdates: settings.summarizeUpdates };
  }
}
