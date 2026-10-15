import type { OwnedEntity } from "@everything/persistence/entity";
import type { GeneralSettings } from "@everything/settings-contracts";

/** One durable set of general preferences per workspace owner. */
export interface StoredGeneralSettings extends OwnedEntity, GeneralSettings {}
