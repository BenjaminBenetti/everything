import type { OwnedEntity } from "@everything/persistence/entity";
import type { KeyType } from "@everything/key-contracts";

/** Encrypted installation-wide material; ownerId records its creator and does not restrict access. */
export interface StoredKey extends OwnedEntity {
  readonly name: string;
  readonly type: KeyType;
  readonly encryptedMaterial: string;
  /** What a generic credential is for; null for SSH keys. */
  readonly description: string | null;
  /** Increases each time the value is replaced, so apps can tell a newer value from an older one. */
  readonly version: number;
  /** When the value was last saved. */
  readonly updatedAt: string;
  /**
   * When a generic credential was deleted. Its value is erased at once; the record remains only
   * until every app that received it has been told to remove it.
   */
  readonly deletedAt: string | null;
}
