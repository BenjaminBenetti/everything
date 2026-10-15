import type {
  OwnerScope,
  Repository,
} from "@everything/persistence/repository";
import type { GeneralSettings } from "@everything/settings-contracts";
import type { StoredGeneralSettings } from "../model/general-settings.js";

/** Persist one settings record for each owner, with ownership applied to every operation. */
export interface GeneralSettingsRepository extends Repository<
  StoredGeneralSettings,
  OwnerScope
> {
  /** Atomically save the owner's preferences, retaining their original record identity. */
  save(scope: OwnerScope, settings: GeneralSettings): Promise<void>;
}

/** General settings use only the owner's singleton listing and save operation. */
export type GeneralSettingsStore = Pick<
  GeneralSettingsRepository,
  "list" | "save"
>;
