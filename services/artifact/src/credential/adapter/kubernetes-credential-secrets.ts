import type { V1Secret } from "@kubernetes/client-node";
import {
  ignoreNotFound,
  isNotFound,
  type KubernetesClients,
} from "../../cluster/factory/kubernetes-client.js";
import {
  artifactLabels,
  credentialSecretName,
  managerName,
} from "../../cluster/model/cluster-names.js";
import { CredentialValueConflictError } from "../error/credential-errors.js";
import type {
  CredentialSecrets,
  StoredCredentialSecret,
} from "../interface/credential-secrets.js";

/** Label naming the identity of the value a credential Secret holds; random, never the value. */
export const credentialValueLabel = "everything.dev/credential-value";

/** Key of the value inside each credential Secret. */
export const credentialSecretKey = "value";

/**
 * Keep granted values in immutable Secrets in the app namespace. Kubernetes stores Secret data
 * base64-encoded; whether etcd encrypts it at rest depends on the cluster's own configuration.
 */
export class KubernetesCredentialSecrets implements CredentialSecrets {
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the core client and the app namespace. */
  constructor(
    private readonly clients: Pick<KubernetesClients, "core">,
    private readonly namespace: string,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /**
   * Create the version's Secret. An existing copy labeled with another value is refused, since a
   * version never carries two values; one whose bytes differ from its own value is restored.
   */
  async write(
    artifactId: string,
    credentialId: string,
    version: number,
    valueId: string,
    value: string,
  ): Promise<void> {
    const body = this.manifest(
      artifactId,
      credentialId,
      version,
      valueId,
      value,
    );
    const name = body.metadata!.name!;
    try {
      await this.clients.core.createNamespacedSecret({
        namespace: this.namespace,
        body,
      });
      return;
    } catch (error) {
      if ((error as { code?: unknown }).code !== 409) throw error;
    }
    const existing = await this.clients.core.readNamespacedSecret({
      name,
      namespace: this.namespace,
    });
    const labeled = existing.metadata?.labels?.[credentialValueLabel];
    if (labeled && labeled !== valueId)
      throw new CredentialValueConflictError();
    if (
      labeled === valueId &&
      existing.data?.[credentialSecretKey] === body.data![credentialSecretKey]
    )
      return;
    // Immutable Secrets can't be changed in place.
    await ignoreNotFound(() =>
      this.clients.core.deleteNamespacedSecret({
        name,
        namespace: this.namespace,
      }),
    );
    await this.clients.core.createNamespacedSecret({
      namespace: this.namespace,
      body,
    });
  }

  /** List credential Secrets by their labels, without reading their values. */
  async stored(artifactId?: string): Promise<StoredCredentialSecret[]> {
    const selector = [
      `${artifactLabels.managedBy}=${managerName}`,
      artifactLabels.credentialId,
      ...(artifactId ? [`${artifactLabels.artifactId}=${artifactId}`] : []),
    ].join(",");
    const secrets = await this.clients.core.listNamespacedSecret({
      namespace: this.namespace,
      labelSelector: selector,
    });
    return secrets.items.flatMap((secret) => {
      const labels = secret.metadata?.labels ?? {};
      const app = labels[artifactLabels.artifactId];
      const credentialId = labels[artifactLabels.credentialId];
      const version = Number(labels[artifactLabels.credentialVersion]);
      const name = secret.metadata?.name;
      return app &&
        credentialId &&
        Number.isSafeInteger(version) &&
        version > 0 &&
        name &&
        !secret.metadata?.deletionTimestamp
        ? [
            {
              artifactId: app,
              credentialId,
              version,
              valueId: labels[credentialValueLabel] ?? null,
              name,
            },
          ]
        : [];
    });
  }

  /** Delete the app's other credential Secrets, treating already deleted ones as done. */
  async prune(artifactId: string, keep: ReadonlySet<string>): Promise<void> {
    for (const secret of await this.stored(artifactId))
      if (!keep.has(secret.name))
        await ignoreNotFound(() =>
          this.clients.core.deleteNamespacedSecret({
            name: secret.name,
            namespace: this.namespace,
          }),
        );
  }

  /** Decode one stored value. */
  async read(name: string): Promise<string | undefined> {
    try {
      const secret = await this.clients.core.readNamespacedSecret({
        name,
        namespace: this.namespace,
      });
      const encoded = secret.data?.[credentialSecretKey];
      return encoded === undefined
        ? undefined
        : Buffer.from(encoded, "base64").toString("utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  // ===========================================
  // Manifests
  // ===========================================

  /** One version's Secret, labeled so it can be found and deleted without reading values. */
  private manifest(
    artifactId: string,
    credentialId: string,
    version: number,
    valueId: string,
    value: string,
  ): V1Secret {
    return {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: credentialSecretName(artifactId, credentialId, version),
        namespace: this.namespace,
        labels: {
          [artifactLabels.managedBy]: managerName,
          [artifactLabels.artifactId]: artifactId,
          [artifactLabels.credentialId]: credentialId,
          [artifactLabels.credentialVersion]: String(version),
          [credentialValueLabel]: valueId,
        },
      },
      type: "Opaque",
      immutable: true,
      data: {
        [credentialSecretKey]: Buffer.from(value, "utf8").toString("base64"),
      },
    };
  }
}
