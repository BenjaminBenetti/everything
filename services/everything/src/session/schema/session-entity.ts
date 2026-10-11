import { EntitySchema } from "typeorm";
import { baseColumns } from "@everything/persistence/schema";
import type { StoredSession } from "../model/stored-session.js";

/** Map encrypted credentials independently from user and agent records. */
export const SessionEntity = new EntitySchema<StoredSession>({
  name: "StoredSession",
  tableName: "browser_sessions",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    tokenHash: { name: "token_hash", type: "text" },
    encryptedGrant: { name: "encrypted_grant", type: "text" },
    expiresAt: { name: "expires_at", type: "timestamptz" },
  },
  indices: [
    {
      name: "browser_sessions_owner_expiry",
      columns: ["ownerId", "expiresAt"],
    },
  ],
});
