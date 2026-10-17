import { EntitySchema } from "typeorm";
import { baseColumns } from "@everything/persistence/schema";
import {
  defaultGeneralSettings,
  defaultTeammateOrder,
} from "@everything/settings-contracts";
import type { StoredGeneralSettings } from "../model/general-settings.js";

/** Map one preference record per owner; absent records use application defaults. */
export const GeneralSettingsEntity = new EntitySchema<StoredGeneralSettings>({
  name: "StoredGeneralSettings",
  tableName: "general_settings",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    summarizeUpdates: {
      name: "summarize_updates",
      type: "boolean",
      default: defaultGeneralSettings.summarizeUpdates,
    },
    teammateIds: {
      name: "teammate_order",
      type: "jsonb",
      default: defaultTeammateOrder.teammateIds,
    },
  },
  uniques: [{ name: "general_settings_owner_key", columns: ["ownerId"] }],
});
