import { EntitySchema } from "typeorm";
import {
  baseColumns,
  timestampTransformer,
} from "@everything/persistence/schema";
import type {
  ViewGrant,
  ViewPass,
  ViewSession,
} from "../model/view-credential.js";

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

/** Map teammate passes to the `view_passes` table; passes are deleted with their artifact. */
export const ViewPassEntity = new EntitySchema<ViewPass>({
  name: "ViewPass",
  tableName: "view_passes",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    artifactId: { name: "artifact_id", type: "uuid" },
    tokenHash: { name: "token_hash", type: "text", unique: true },
    path: { type: "text" },
    expiresAt: {
      name: "expires_at",
      type: "timestamptz",
      transformer: timestampTransformer,
    },
  },
});
