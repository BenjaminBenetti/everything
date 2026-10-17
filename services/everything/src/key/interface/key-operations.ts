import type {
  CreateKeyInput,
  SavedKey,
  RenameKeyInput,
} from "@everything/key-contracts";

/** Manage key metadata without exposing secret retrieval or key execution. */
export interface KeyOperations {
  /** List the installation's shared key metadata for an authenticated member. */
  list(actorId: string): Promise<SavedKey[]>;
  /** Validate and encrypt a new key. */
  create(actorId: string, input: CreateKeyInput): Promise<SavedKey>;
  /** Rename an existing key without accessing its material. */
  rename(actorId: string, id: string, input: RenameKeyInput): Promise<SavedKey>;
  /** Delete a shared key on behalf of an authenticated installation member. */
  delete(actorId: string, id: string): Promise<void>;
}
