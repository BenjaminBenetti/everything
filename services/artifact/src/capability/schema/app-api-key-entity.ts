import { EntitySchema } from "typeorm";
import { baseColumns } from "@everything/persistence/schema";
import type { AppApiKeyRecord } from "../model/app-api-key.js";

/** Map API key verification records to the `app_api_keys` table; rows are removed with their app. */
export const AppApiKeyEntity = new EntitySchema<AppApiKeyRecord>({
  name: "AppApiKey",
  tableName: "app_api_keys",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    artifactId: { name: "artifact_id", type: "uuid", unique: true },
    keyHash: { name: "key_hash", type: "text" },
  },
});
