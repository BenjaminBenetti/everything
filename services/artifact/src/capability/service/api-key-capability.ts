import { appApiKeyVariable } from "@everything/artifact-contracts/api-key";
import type { AppApiKeyStore } from "../interface/app-api-key-store.js";
import type {
  CapabilityOwner,
  CapabilityProvider,
} from "../interface/artifact-capabilities.js";
import { newAppApiKey } from "../model/app-api-key.js";

/** Give an app a key that external callers send to reach it through the app host. */
export class ApiKeyCapability implements CapabilityProvider {
  readonly name = "api-key";

  // ===========================================
  // Construction
  // ===========================================

  /** Keep where keys are stored independent of the capability's lifecycle. */
  constructor(
    private readonly keys: Pick<
      AppApiKeyStore,
      "current" | "replace" | "revoke"
    >,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Keep the current key across redeployments and restarts, or create one when there is none. */
  async ensure(
    owner: CapabilityOwner,
  ): Promise<Readonly<Record<string, string>>> {
    const scope = { ownerId: owner.ownerId, artifactId: owner.id };
    let key = await this.keys.current(scope);
    if (!key) {
      key = newAppApiKey();
      await this.keys.replace(scope, key);
    }
    return { [appApiKeyVariable]: key };
  }

  /** Revoke the key; enabling the capability again creates a new one. */
  async remove(owner: CapabilityOwner): Promise<void> {
    await this.keys.revoke({ ownerId: owner.ownerId, artifactId: owner.id });
  }
}
