import {
  PatchStrategy,
  type KubernetesObject,
  type V1Pod,
} from "@kubernetes/client-node";
import type { ArtifactRuntime } from "@everything/artifact-contracts";
import {
  ignoreNotFound,
  isNotFound,
  type KubernetesClients,
} from "../../cluster/factory/kubernetes-client.js";
import {
  artifactLabels,
  artifactResourceName,
  databaseSecretName,
  diskClaimName,
  managerName,
} from "../../cluster/model/cluster-names.js";
import type { DatabaseConnection } from "../../database/interface/artifact-databases.js";
import type {
  ArtifactWorkload,
  LogOptions,
  WorkloadOrchestrator,
} from "../interface/workload-orchestrator.js";
import {
  runtimeFromPods,
  type PodObservation,
} from "../model/runtime-state.js";
import {
  containerName,
  databaseSecretManifest,
  deploymentManifest,
  diskClaimManifest,
  serviceManifest,
  statefulSetManifest,
  type WorkloadSettings,
} from "./workload-manifests.js";

/** Reduce a pod to what decides the artifact's runtime status. */
function observe(pod: V1Pod): PodObservation {
  const app = pod.status?.containerStatuses?.find(
    (status) => status.name === containerName,
  );
  return {
    phase: pod.status?.phase ?? "Pending",
    ready: app?.ready ?? false,
    restarts: app?.restartCount ?? 0,
    waitingReason: app?.state?.waiting?.reason ?? null,
  };
}

/** Runs artifacts as Deployments or StatefulSets in the artifact namespace, applied server-side. */
export class KubernetesWorkloads implements WorkloadOrchestrator {
  // ===========================================
  // Construction
  // ===========================================

  /** Use the Kubernetes clients in the configured artifact namespace. */
  constructor(
    private readonly clients: KubernetesClients,
    private readonly settings: WorkloadSettings,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Create the disk if needed, apply the workload of the right kind, then its Service. */
  async apply(workload: ArtifactWorkload): Promise<void> {
    const diskGi = workload.settings.diskGi;
    if (diskGi !== null) {
      await this.createDisk(workload, diskGi);
      await this.serverSideApply(statefulSetManifest(workload, this.settings));
      await this.deleteDeployment(workload.artifactId);
    } else {
      await this.serverSideApply(deploymentManifest(workload, this.settings));
      await this.deleteStatefulSet(workload.artifactId);
    }
    await this.serverSideApply(serviceManifest(workload, this.settings));
  }

  /** Delete the workload; its Service, Secret, and disk stay for the next deployment. */
  async stop(artifactId: string): Promise<void> {
    await this.deleteDeployment(artifactId);
    await this.deleteStatefulSet(artifactId);
  }

  /** Delete every object of the artifact, including its disk and its data. */
  async remove(artifactId: string): Promise<void> {
    const name = artifactResourceName(artifactId);
    const namespace = this.settings.namespace;
    await this.stop(artifactId);
    await ignoreNotFound(() =>
      this.clients.core.deleteNamespacedService({ name, namespace }),
    );
    await ignoreNotFound(() =>
      this.clients.core.deleteNamespacedSecret({
        name: databaseSecretName(artifactId),
        namespace,
      }),
    );
    await ignoreNotFound(() =>
      this.clients.core.deleteNamespacedPersistentVolumeClaim({
        name: diskClaimName(artifactId),
        namespace,
      }),
    );
  }

  /** List every artifact pod once and summarize them per artifact. */
  async runtimes(): Promise<ReadonlyMap<string, ArtifactRuntime>> {
    const pods = await this.clients.core.listNamespacedPod({
      namespace: this.settings.namespace,
      labelSelector: `${artifactLabels.managedBy}=${managerName}`,
    });
    const byArtifact = new Map<string, PodObservation[]>();
    for (const pod of pods.items) {
      const artifactId = pod.metadata?.labels?.[artifactLabels.artifactId];
      if (!artifactId || pod.metadata?.deletionTimestamp) continue;
      byArtifact.set(artifactId, [
        ...(byArtifact.get(artifactId) ?? []),
        observe(pod),
      ]);
    }
    return new Map(
      [...byArtifact].map(([artifactId, observed]) => [
        artifactId,
        runtimeFromPods(observed),
      ]),
    );
  }

  /** Read the newest pod's container output; an absent or unstarted container yields nothing. */
  async logs(artifactId: string, options: LogOptions): Promise<string> {
    const pods = await this.clients.core.listNamespacedPod({
      namespace: this.settings.namespace,
      labelSelector: `${artifactLabels.artifactId}=${artifactId}`,
    });
    const pod = pods.items
      .slice()
      .sort(
        (a, b) =>
          (b.metadata?.creationTimestamp?.getTime() ?? 0) -
          (a.metadata?.creationTimestamp?.getTime() ?? 0),
      )[0];
    if (!pod?.metadata?.name) return "";
    try {
      return await this.clients.core.readNamespacedPodLog({
        name: pod.metadata.name,
        namespace: this.settings.namespace,
        container: containerName,
        previous: options.previous,
        tailLines: options.lines,
      });
    } catch (error) {
      // Kubernetes answers 400 while the container has not started or has no previous run.
      const code = (error as { code?: unknown }).code;
      if (code === 400 || code === 404) return "";
      throw error;
    }
  }

  /** Decode the password from the artifact's database Secret. */
  async databasePassword(artifactId: string): Promise<string | undefined> {
    try {
      const secret = await this.clients.core.readNamespacedSecret({
        name: databaseSecretName(artifactId),
        namespace: this.settings.namespace,
      });
      const encoded = secret.data?.PGPASSWORD;
      return encoded ? Buffer.from(encoded, "base64").toString() : undefined;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /** Apply the artifact's database Secret. */
  async writeDatabaseSecret(
    artifactId: string,
    connection: DatabaseConnection,
  ): Promise<void> {
    await this.serverSideApply(
      databaseSecretManifest(artifactId, connection, this.settings),
    );
  }

  // ===========================================
  // Kubernetes objects
  // ===========================================

  /** Apply an object as this service's field manager, taking over fields it set before. */
  private async serverSideApply(object: KubernetesObject): Promise<void> {
    await this.clients.objects.patch(
      object,
      undefined,
      undefined,
      managerName,
      true,
      PatchStrategy.ServerSideApply,
    );
  }

  /** Create the disk once; its size never changes afterwards. */
  private async createDisk(
    workload: ArtifactWorkload,
    sizeGi: number,
  ): Promise<void> {
    try {
      await this.clients.core.createNamespacedPersistentVolumeClaim({
        namespace: this.settings.namespace,
        body: diskClaimManifest(workload, sizeGi, this.settings),
      });
    } catch (error) {
      if ((error as { code?: unknown }).code !== 409) throw error;
    }
  }

  /** Delete the artifact's Deployment, if any. */
  private async deleteDeployment(artifactId: string): Promise<void> {
    await ignoreNotFound(() =>
      this.clients.apps.deleteNamespacedDeployment({
        name: artifactResourceName(artifactId),
        namespace: this.settings.namespace,
      }),
    );
  }

  /** Delete the artifact's StatefulSet, if any. */
  private async deleteStatefulSet(artifactId: string): Promise<void> {
    await ignoreNotFound(() =>
      this.clients.apps.deleteNamespacedStatefulSet({
        name: artifactResourceName(artifactId),
        namespace: this.settings.namespace,
      }),
    );
  }
}
