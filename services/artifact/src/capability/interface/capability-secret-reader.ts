import type { ArtifactCapability } from "@everything/artifact-contracts";

/** Read provisioned credentials without permission to change their lifecycle. */
export interface CapabilitySecretReader {
  /** Read one app's capability environment; undefined means the Secret is absent. */
  read(
    appId: string,
    capability: ArtifactCapability,
  ): Promise<Readonly<Record<string, string>> | undefined>;
}
