import type {
  CreateKeyInput,
  RenameKeyInput,
  SavedKey,
} from "@everything/key-contracts";

/** Browser capabilities for key management, with no secret retrieval operation. */
export interface KeyDirectory {
  /** Load only public metadata for the signed-in owner. */
  list(signal?: AbortSignal): Promise<SavedKey[]>;
  /** Upload secret material once and receive metadata. */
  create(input: CreateKeyInput): Promise<SavedKey>;
  /** Rename a stored key without retrieving its contents. */
  rename(id: string, input: RenameKeyInput): Promise<SavedKey>;
  /** Remove a key from the owner's directory. */
  delete(id: string): Promise<void>;
}
