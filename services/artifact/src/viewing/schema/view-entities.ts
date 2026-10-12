import { EntitySchema } from "typeorm";
import {
  baseColumns,
  timestampTransformer,
} from "@everything/persistence/schema";
import type { ViewGrant, ViewSession } from "../model/view-credential.js";

/** Map view links to the `view_grants` table. */
export const ViewGrantEntity = new EntitySchema<ViewGrant>({
  name: "ViewGrant",
  tableName: "view_grants",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    tokenHash: { name: "token_hash", type: "text", unique: true },
    next: { type: "text" },
    expiresAt: {
      name: "expires_at",
      type: "timestamptz",
      transformer: timestampTransformer,
    },
    usedAt: {
      name: "used_at",
      type: "timestamptz",
      nullable: true,
      transformer: timestampTransformer,
    },
  },
});

/** Map artifact host sessions to the `view_sessions` table. */
export const ViewSessionEntity = new EntitySchema<ViewSession>({
  name: "ViewSession",
  tableName: "view_sessions",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    tokenHash: { name: "token_hash", type: "text", unique: true },
    expiresAt: {
      name: "expires_at",
      type: "timestamptz",
      transformer: timestampTransformer,
    },
  },
});
