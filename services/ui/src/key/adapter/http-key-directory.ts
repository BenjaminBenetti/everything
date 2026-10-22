import type {
  CreateKeyInput,
  RenameKeyInput,
  ReplaceKeyValueInput,
  SavedKey,
  KeyList,
} from "@everything/key-contracts";
import type {
  CredentialRollout,
  CredentialUsage,
} from "@everything/artifact-contracts/credential";
import type { JsonTransport } from "../../http/interface/json-transport.js";
import type {
  KeyDirectory,
  KeyValueReplacement,
} from "../interface/key-directory.js";

/** Map key operations to the authenticated API using shared transport policy. */
export class HttpKeyDirectory implements KeyDirectory {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive authentication and error policy independently of key management. */
  constructor(private readonly transport: JsonTransport) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Fetch a cancellable metadata-only listing. */
  async list(signal?: AbortSignal): Promise<SavedKey[]> {
    const result = await this.transport.request<KeyList>(
      "/v1/keys",
      signal ? { signal } : {},
    );
    return result.keys;
  }

  /** Transmit material only on explicit submission. */
  create(input: CreateKeyInput): Promise<SavedKey> {
    return this.transport.request("/v1/keys", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Change only the key's display name, and a generic credential's description. */
  rename(id: string, input: RenameKeyInput): Promise<SavedKey> {
    return this.transport.request(this.path(id), {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  /** Send a new value once; the answer carries metadata and app statuses only. */
  replaceValue(
    id: string,
    input: ReplaceKeyValueInput,
  ): Promise<KeyValueReplacement> {
    return this.transport.request(`${this.path(id)}/value`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  /** Delete through the protected endpoint; SSH keys answer without a body. */
  async delete(id: string): Promise<CredentialRollout | undefined> {
    const result = await this.transport.request<
      { readonly rollout: CredentialRollout } | undefined
    >(this.path(id), { method: "DELETE" });
    return result?.rollout;
  }

  /** Read which of the user's apps receive the credential. */
  usage(id: string, signal?: AbortSignal): Promise<CredentialUsage> {
    return this.transport.request(
      `${this.path(id)}/apps`,
      signal ? { signal } : {},
    );
  }

  // ===========================================
  // Paths
  // ===========================================

  /** Path of one key. */
  private path(id: string): string {
    return `/v1/keys/${encodeURIComponent(id)}`;
  }
}
