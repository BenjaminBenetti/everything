import type { OwnedEntity } from "@everything/persistence/entity";
import type {
  GeneralSettings,
  TeammateOrder,
} from "@everything/settings-contracts";

/** Every preference kept in the owner's single settings record. */
export type GeneralPreferences = GeneralSettings & TeammateOrder;

/** One durable set of general preferences per workspace owner. */
export interface StoredGeneralSettings
  extends OwnedEntity, GeneralSettings, TeammateOrder {}
