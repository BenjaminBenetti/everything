import { EntitySchema } from "typeorm";
import {
  baseColumns,
  timestampTransformer,
} from "@everything/persistence/schema";
import { keyLimits } from "@everything/key-contracts";
import type { StoredKey } from "../model/stored-key.js";

/**
 * Key types remain data rather than separate tables or database enums. The migration also keeps
 * live generic credential names unique regardless of case, which an EntitySchema can't express.
 */
export const KeyEntity = new EntitySchema<StoredKey>({
  name: "StoredKey",
  tableName: "keys",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    name: { type: "varchar", length: keyLimits.nameLength },
    type: { type: "varchar", length: keyLimits.typeLength },
    encryptedMaterial: { name: "encrypted_material", type: "text" },
    description: {
      type: "varchar",
      length: keyLimits.descriptionLength,
      nullable: true,
    },
    version: { type: "integer", default: 1 },
    valueId: { name: "value_id", type: "uuid", nullable: true },
    updatedAt: {
      name: "updated_at",
      type: "timestamptz",
      transformer: timestampTransformer,
    },
    deletedAt: {
      name: "deleted_at",
      type: "timestamptz",
      nullable: true,
      transformer: timestampTransformer,
    },
  },
  indices: [
    { name: "keys_owner_created", columns: ["ownerId", "createdAt", "id"] },
  ],
});
