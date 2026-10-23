import type { Repository } from "@everything/persistence/repository";
import type { StoredKey } from "../model/stored-key.js";
import type { KeyScope } from "../model/key-scope.js";

/** Installation-scoped persistence for extensible key records. */
export interface KeyRepository extends Repository<StoredKey, KeyScope> {
  /** Insert a newly encrypted record attributed to its authenticated creator. */
  create(scope: KeyScope, key: StoredKey): Promise<void>;
  /** Rename a live record, and set a generic credential's description when given. */
  rename(
    scope: KeyScope,
    id: string,
    name: string,
    description?: string,
  ): Promise<StoredKey | undefined>;
  /**
   * Store a live generic credential's new encrypted value and raise its version in one update,
   * only for the credential's creator.
   */
  replaceMaterial(
    scope: KeyScope,
    id: string,
    encryptedMaterial: string,
    valueId: string,
  ): Promise<StoredKey | undefined>;
  /** Mark a generic credential deleted and erase its value, keeping the record for removal from apps. */
  markDeleted(scope: KeyScope, id: string): Promise<void>;
}
