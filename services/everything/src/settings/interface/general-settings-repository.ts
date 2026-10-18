import type {
  OwnerScope,
  Repository,
} from "@everything/persistence/repository";
import type {
  GeneralPreferences,
  StoredGeneralSettings,
} from "../model/general-settings.js";

/** Persist one settings record for each owner, with ownership applied to every operation. */
export interface GeneralSettingsRepository extends Repository<
  StoredGeneralSettings,
  OwnerScope
> {
  /** Atomically save the given preferences, keeping the others and the record's original identity. */
  save(
    scope: OwnerScope,
    preferences: Partial<GeneralPreferences>,
  ): Promise<void>;
}

/** General settings use only the owner's singleton listing and save operation. */
export type GeneralSettingsStore = Pick<
  GeneralSettingsRepository,
  "list" | "save"
>;
