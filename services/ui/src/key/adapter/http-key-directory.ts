import type {
  CreateKeyInput,
  RenameKeyInput,
  SavedKey,
  KeyList,
} from "@everything/key-contracts";
import type { JsonTransport } from "../../http/interface/json-transport.js";
import type { KeyDirectory } from "../interface/key-directory.js";

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

  /** Change only the key's display name. */
  rename(id: string, input: RenameKeyInput): Promise<SavedKey> {
    return this.transport.request(`/v1/keys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  /** Delete through the owner's protected endpoint. */
  delete(id: string): Promise<void> {
    return this.transport.request(`/v1/keys/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
}
