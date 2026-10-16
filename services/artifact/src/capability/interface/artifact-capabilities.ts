import type { ArtifactCapability } from "@everything/artifact-contracts";

/** Stable identity needed by capability providers, independent of artifact persistence. */
export interface CapabilityOwner {
  readonly id: string;
  readonly ownerId: string;
}

/** One backend capability with its own provisioning and cleanup policy. */
export interface CapabilityProvider {
  readonly name: ArtifactCapability;
  /** Provision the capability and return the variables kept in its Kubernetes Secret. */
  ensure(owner: CapabilityOwner): Promise<Readonly<Record<string, string>>>;
  /** Remove the capability's external resources. */
  remove(appId: string): Promise<void>;
}

/** Credentials are written only to app-owned Kubernetes Secrets. */
export interface CapabilitySecrets {
  /** Write a capability's environment and return its Secret name. */
  write(
    appId: string,
    capability: ArtifactCapability,
    values: Readonly<Record<string, string>>,
  ): Promise<string>;
  /** Delete a capability's Secret if it exists. */
  remove(appId: string, capability: ArtifactCapability): Promise<void>;
}

/** References and change detection, without credential values, passed to workload generation. */
export interface CapabilityEnvironment {
  readonly secretNames: readonly string[];
  readonly fingerprint: string | null;
}

/** Capability lifecycle consumed by workload reconciliation. */
export interface ArtifactCapabilities {
  /** Provision requested capabilities and remove capabilities no longer requested. */
  reconcile(
    owner: CapabilityOwner,
    enabled: readonly ArtifactCapability[],
  ): Promise<CapabilityEnvironment>;
  /** Remove every capability belonging to a deleted app. */
  remove(appId: string): Promise<void>;
}
