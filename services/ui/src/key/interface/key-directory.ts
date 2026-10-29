import type {
  CreateKeyInput,
  RenameKeyInput,
  ReplaceKeyValueInput,
  SavedKey,
} from "@everything/key-contracts";
import type {
  CredentialRollout,
  CredentialUsage,
} from "@everything/artifact-contracts/credential";

/** A generic credential after its value was replaced, and where its apps stand. */
export interface KeyValueReplacement {
  readonly key: SavedKey;
  readonly rollout: CredentialRollout;
}

/** Browser capabilities for key management, with no secret retrieval operation. */
export interface KeyDirectory {
  /** Load only public metadata for the signed-in owner. */
  list(signal?: AbortSignal): Promise<SavedKey[]>;
  /** Upload secret material once and receive metadata. */
  create(input: CreateKeyInput): Promise<SavedKey>;
  /** Rename a stored key, or edit a generic credential's description, without retrieving its contents. */
  rename(id: string, input: RenameKeyInput): Promise<SavedKey>;
  /** Replace a generic credential's value; only metadata and app statuses come back. */
  replaceValue(
    id: string,
    input: ReplaceKeyValueInput,
  ): Promise<KeyValueReplacement>;
  /** Remove a key; a generic credential reports how its removal from apps went. */
  delete(id: string): Promise<CredentialRollout | undefined>;
  /** List the apps that receive a generic credential, with their statuses. */
  usage(id: string, signal?: AbortSignal): Promise<CredentialUsage>;
}
