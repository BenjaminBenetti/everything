import { appApiKeyVariable } from "@everything/artifact-contracts/api-key";
import type { WithinArtifactScope } from "../../artifact/interface/artifact-repository.js";
import type { AppApiKeyRepository } from "../interface/app-api-key-repository.js";
import type { AppApiKeyStore } from "../interface/app-api-key-store.js";
import type { CapabilitySecretReader } from "../interface/capability-secret-reader.js";
import { appApiKeyHash, matchesAppApiKey } from "../model/app-api-key.js";

/**
 * Store only a hash of each key in PostgreSQL, and recover the key from the app's capability
 * Secret, where reconciliation writes it for the backend's environment.
 */
export class HashedAppApiKeyStore implements AppApiKeyStore {
  // ===========================================
  // Construction
  // ===========================================

  /** Bind verification records and a read-only view of provisioned environments. */
  constructor(
    private readonly records: AppApiKeyRepository,
    private readonly secrets: CapabilitySecretReader,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** The Secret's key, only while it matches the verification record. */
  async current(scope: WithinArtifactScope): Promise<string | undefined> {
    const [record, environment] = await Promise.all([
      this.records.find(scope),
      this.secrets.read(scope.artifactId, "api-key"),
    ]);
    const key = environment?.[appApiKeyVariable];
    return record && key && matchesAppApiKey(key, record.keyHash)
      ? key
      : undefined;
  }

  /** Record the new key's hash; reconciliation then writes the key to the app's Secret. */
  async replace(scope: WithinArtifactScope, key: string): Promise<void> {
    await this.records.replace(scope, appApiKeyHash(key));
  }

  /** Check the key against the app's record. */
  async verifies(scope: WithinArtifactScope, key: string): Promise<boolean> {
    const record = await this.records.find(scope);
    return record !== undefined && matchesAppApiKey(key, record.keyHash);
  }

  /** Delete the verification record, so the key stops working even before its Secret is removed. */
  async revoke(scope: WithinArtifactScope): Promise<void> {
    await this.records.revoke(scope);
  }
}
