import type { OwnedEntity } from "@everything/persistence/entity";
import type { KeyType } from "@everything/key-contracts";

/** Encrypted installation-wide material; ownerId records its creator and does not restrict access. */
export interface StoredKey extends OwnedEntity {
  readonly name: string;
  readonly type: KeyType;
  readonly encryptedMaterial: string;
}
