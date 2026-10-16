import { createHash } from "node:crypto";
import type { ArtifactCapability } from "@everything/artifact-contracts";
import type {
  ArtifactCapabilities,
  CapabilityEnvironment,
  CapabilityOwner,
  CapabilityProvider,
  CapabilitySecrets,
} from "../interface/artifact-capabilities.js";

/** Coordinate independently provisioned capabilities without exposing their credentials to workloads. */
export class ProvisionedArtifactCapabilities implements ArtifactCapabilities {
  // ===========================================
  // Construction
  // ===========================================

  /** Bind capability providers and the app-scoped credential store. */
  constructor(
    private readonly providers: readonly CapabilityProvider[],
    private readonly secrets: CapabilitySecrets,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Reconcile every provider, hashing environment changes so restored credentials roll the pod. */
  async reconcile(
    owner: CapabilityOwner,
    enabled: readonly ArtifactCapability[],
  ): Promise<CapabilityEnvironment> {
    const secretNames: string[] = [];
    const fingerprint = createHash("sha256");
    for (const name of enabled)
      if (!this.providers.some((provider) => provider.name === name))
        throw new Error("Unsupported app capability");
    for (const provider of this.providers) {
      if (!enabled.includes(provider.name)) {
        await this.removeProvider(owner.id, provider);
        continue;
      }
      const values = await provider.ensure(owner);
      secretNames.push(
        await this.secrets.write(owner.id, provider.name, values),
      );
      fingerprint.update(
        JSON.stringify([
          provider.name,
          Object.entries(values).sort(([a], [b]) => a.localeCompare(b)),
        ]),
      );
    }
    return {
      secretNames,
      fingerprint: secretNames.length ? fingerprint.digest("hex") : null,
    };
  }

  /** Revoke external clients before deleting their stored credentials. */
  async remove(appId: string): Promise<void> {
    for (const provider of this.providers)
      await this.removeProvider(appId, provider);
  }

  // ===========================================
  // Cleanup
  // ===========================================

  /** Leave the Secret available for retry until external revocation succeeds. */
  private async removeProvider(
    appId: string,
    provider: CapabilityProvider,
  ): Promise<void> {
    await provider.remove(appId);
    await this.secrets.remove(appId, provider.name);
  }
}
