import { PatchStrategy } from "@kubernetes/client-node";
import type { ArtifactCapability } from "@everything/artifact-contracts";
import {
  ignoreNotFound,
  isNotFound,
  type KubernetesClients,
} from "../../cluster/factory/kubernetes-client.js";
import {
  artifactLabels,
  artifactResourceName,
  managerName,
} from "../../cluster/model/cluster-names.js";
import type { CapabilitySecrets } from "../interface/artifact-capabilities.js";
import type { CapabilitySecretReader } from "../interface/capability-secret-reader.js";

/** Name of the app's Secret for one provisioned capability. */
function secretName(appId: string, capability: ArtifactCapability): string {
  return `${artifactResourceName(appId)}-${capability}`;
}

/** Persist generated app credentials in the artifact namespace, never in deployment records. */
export class KubernetesCapabilitySecrets
  implements CapabilitySecrets, CapabilitySecretReader
{
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the smallest Kubernetes client subset and the app namespace. */
  constructor(
    private readonly clients: Pick<KubernetesClients, "core" | "objects">,
    private readonly namespace: string,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Apply values as Secret data, keeping secret values out of pod manifests. */
  async write(
    appId: string,
    capability: ArtifactCapability,
    values: Readonly<Record<string, string>>,
  ): Promise<string> {
    const name = secretName(appId, capability);
    await this.clients.objects.patch(
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name,
          namespace: this.namespace,
          labels: {
            [artifactLabels.managedBy]: managerName,
            [artifactLabels.artifactId]: appId,
          },
        },
        type: "Opaque",
        data: Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key,
            Buffer.from(value).toString("base64"),
          ]),
        ),
      },
      undefined,
      undefined,
      managerName,
      true,
      PatchStrategy.ServerSideApply,
    );
    return name;
  }

  /** Remove the capability's credentials, succeeding when already absent. */
  async remove(appId: string, capability: ArtifactCapability): Promise<void> {
    await ignoreNotFound(() =>
      this.clients.core.deleteNamespacedSecret({
        name: secretName(appId, capability),
        namespace: this.namespace,
      }),
    );
  }
  /** Read the app's current credentials, distinguishing absence from a failed lookup. */
  async read(
    appId: string,
    capability: ArtifactCapability,
  ): Promise<Readonly<Record<string, string>> | undefined> {
    try {
      const secret = await this.clients.core.readNamespacedSecret({
        name: secretName(appId, capability),
        namespace: this.namespace,
      });
      return Object.fromEntries(
        Object.entries(secret.data ?? {}).map(([key, value]) => [
          key,
          Buffer.from(value, "base64").toString("utf8"),
        ]),
      );
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }
}
