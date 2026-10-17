import { EntitySchema } from "typeorm";
import { baseColumns } from "@everything/persistence/schema";
import { keyLimits } from "@everything/key-contracts";
import type { StoredKey } from "../model/stored-key.js";

/** Key types remain data rather than separate tables or database enums. */
export const KeyEntity = new EntitySchema<StoredKey>({
  name: "StoredKey",
  tableName: "keys",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    name: { type: "varchar", length: keyLimits.nameLength },
    type: { type: "varchar", length: keyLimits.typeLength },
    encryptedMaterial: { name: "encrypted_material", type: "text" },
  },
  indices: [
    { name: "keys_owner_created", columns: ["ownerId", "createdAt", "id"] },
  ],
});
