import type {
  CreateKeyInput,
  KeyType,
  RenameKeyInput,
  ReplaceKeyValueInput,
  SavedKey,
} from "@everything/key-contracts";
import type { KeyActor } from "../model/key-actor.js";

/** Manage key metadata and values without exposing secret retrieval or key execution. */
export interface KeyOperations {
  /** List the installation's shared key metadata for an authenticated member. */
  list(actor: KeyActor): Promise<SavedKey[]>;
  /** Validate and encrypt a new key. */
  create(actor: KeyActor, input: CreateKeyInput): Promise<SavedKey>;
  /** Rename an existing key, or describe a generic credential, without accessing its material. */
  rename(actor: KeyActor, id: string, input: RenameKeyInput): Promise<SavedKey>;
  /** Encrypt a generic credential's new value as its next version; only its creator may. */
  replaceValue(
    actor: KeyActor,
    id: string,
    input: ReplaceKeyValueInput,
  ): Promise<SavedKey>;
  /**
   * Delete a key: an SSH key at once, a generic credential by erasing its value and keeping its
   * record until apps no longer hold it. Returns the deleted key's type, or undefined when absent.
   */
  delete(actor: KeyActor, id: string): Promise<KeyType | undefined>;
}
