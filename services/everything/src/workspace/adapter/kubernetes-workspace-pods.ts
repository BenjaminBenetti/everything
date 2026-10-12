import { setTimeout as sleep } from "node:timers/promises";
import {
  AppsV1Api,
  CoreV1Api,
  KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
  type KubernetesObject,
  type V1PodTemplateSpec,
  type V1StatefulSet,
  type V1Service,
} from "@kubernetes/client-node";
import type { WorkspacePods } from "../interface/workspace-pods.js";
import {
  workspaceLabels,
  workspaceManager,
  workspaceResourceName,
  workspaceToken,
} from "../model/workspace-access.js";

/** Cluster-owned settings; the reusable pod template comes from the single Helm chart. */
export interface WorkspacePodSettings {
  readonly namespace: string;
  readonly templateName: string;
  readonly claimName: string;
  readonly key: string;
}

/** Build the clients once at the application composition boundary. */
export function createWorkspacePodClients() {
  const config = new KubeConfig();
  config.loadFromDefault();
  return {
    core: config.makeApiClient(CoreV1Api),
    apps: config.makeApiClient(AppsV1Api),
    objects: KubernetesObjectApi.makeApiClient(config),
  };
}

/** Build a singleton StatefulSet from the chart's zero-replica tools template. */
export function workspaceStatefulSet(
  agentId: string,
  source: V1PodTemplateSpec,
  settings: WorkspacePodSettings,
): V1StatefulSet {
  const name = workspaceResourceName(agentId);
  const labels = {
    [workspaceLabels.manager]: workspaceManager,
    [workspaceLabels.identity]: agentId,
  };
  const template = structuredClone(source);
  if (!template.spec || template.spec.containers.length !== 1)
    throw new Error("Invalid workspace pod template");
  template.metadata = {
    ...template.metadata,
    labels: { ...template.metadata?.labels, ...labels },
  };
  template.spec.automountServiceAccountToken = false;
  template.spec.enableServiceLinks = false;
  template.spec.affinity = {
    podAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: [
        {
          labelSelector: {
            matchLabels: { "app.kubernetes.io/name": "everything" },
          },
          topologyKey: "kubernetes.io/hostname",
        },
      ],
    },
  };
  const container = template.spec.containers[0]!;
  container.env = [
    ...(container.env ?? []).filter(
      (variable) => variable.name !== "WORKSPACE_TOKEN",
    ),
    { name: "WORKSPACE_TOKEN", value: workspaceToken(settings.key, agentId) },
  ];
  const mount = container.volumeMounts?.find(
    (volume) => volume.name === "workspace",
  );
  if (
    !mount ||
    !template.spec.volumes?.some((volume) => volume.name === "workspace")
  )
    throw new Error("Workspace template must mount the workspace volume");
  mount.subPath = agentId;
  template.spec.volumes = template.spec.volumes.map((volume) =>
    volume.name === "workspace"
      ? {
          name: "workspace",
          persistentVolumeClaim: { claimName: settings.claimName },
        }
      : volume,
  );
  return {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name, namespace: settings.namespace, labels },
    spec: {
      replicas: 1,
      serviceName: name,
      selector: { matchLabels: labels },
      template,
    },
  };
}

/** Let Kubernetes restore missing pods, while Everything reconciles workloads against the database. */
export class KubernetesWorkspacePods implements WorkspacePods {
  /** Restrict all calls to the configured namespace and resources owned by this controller. */
  constructor(
    private readonly clients: ReturnType<typeof createWorkspacePodClients>,
    private readonly settings: WorkspacePodSettings,
  ) {}

  /** Include orphan Services so interrupted creation and deletion can be repaired. */
  async list(): Promise<readonly string[]> {
    const request = {
      namespace: this.settings.namespace,
      labelSelector: `${workspaceLabels.manager}=${workspaceManager}`,
    };
    const [sets, services] = await Promise.all([
      this.clients.apps.listNamespacedStatefulSet(request),
      this.clients.core.listNamespacedService(request),
    ]);
    return [
      ...new Set(
        [...sets.items, ...services.items].flatMap(
          (item) => item.metadata?.labels?.[workspaceLabels.identity] ?? [],
        ),
      ),
    ];
  }

  /** Reapply the current Helm template; template changes roll each singleton pod without losing files. */
  async ensure(agentId: string): Promise<void> {
    const source = await this.clients.apps.readNamespacedStatefulSet({
      namespace: this.settings.namespace,
      name: this.settings.templateName,
    });
    const workload = workspaceStatefulSet(
      agentId,
      source.spec!.template,
      this.settings,
    );
    const service: V1Service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: workload.metadata!,
      spec: {
        selector: workload.spec!.selector.matchLabels!,
        ports: [{ name: "http", port: 8080, targetPort: "http" }],
      },
    };
    await this.apply(service);
    await this.apply(workload);
  }

  /** Delete only managed resources and wait for pod termination before files can be removed. */
  async remove(agentId: string): Promise<void> {
    const name = workspaceResourceName(agentId);
    const namespace = this.settings.namespace;
    await this.ignoreMissing(() =>
      this.clients.apps.deleteNamespacedStatefulSet({
        name,
        namespace,
        propagationPolicy: "Foreground",
      }),
    );
    const deadline = Date.now() + 45_000;
    while (true) {
      const pods = await this.clients.core.listNamespacedPod({
        namespace,
        labelSelector: `${workspaceLabels.manager}=${workspaceManager},${workspaceLabels.identity}=${agentId}`,
      });
      if (!pods.items.length) break;
      if (Date.now() >= deadline)
        throw new Error("Workspace pod termination is still pending");
      await sleep(250);
    }
    await this.ignoreMissing(() =>
      this.clients.core.deleteNamespacedService({ name, namespace }),
    );
  }

  /** Use server-side apply so reconciliation is idempotent and repairs configuration drift. */
  private async apply(object: KubernetesObject): Promise<void> {
    await this.clients.objects.patch(
      object,
      undefined,
      undefined,
      workspaceManager,
      true,
      PatchStrategy.ServerSideApply,
    );
  }

  /** Missing resources already satisfy deletion's desired state. */
  private async ignoreMissing(
    operation: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if ((error as { code?: number }).code !== 404) throw error;
    }
  }
}
