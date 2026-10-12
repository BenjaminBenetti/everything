import {
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  KubernetesObjectApi,
} from "@kubernetes/client-node";

/** Kubernetes API clients sharing one configuration. */
export interface KubernetesClients {
  readonly core: CoreV1Api;
  readonly apps: AppsV1Api;
  readonly batch: BatchV1Api;
  /** Generic client for server-side apply of any object. */
  readonly objects: KubernetesObjectApi;
}

/** Connect with the pod's service account in the cluster, or the local kubeconfig elsewhere. */
export function createKubernetesClients(): KubernetesClients {
  const config = new KubeConfig();
  config.loadFromDefault();
  return {
    core: config.makeApiClient(CoreV1Api),
    apps: config.makeApiClient(AppsV1Api),
    batch: config.makeApiClient(BatchV1Api),
    objects: KubernetesObjectApi.makeApiClient(config),
  };
}

/** Whether a Kubernetes API call failed because the object does not exist. */
export function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 404;
}

/** Run a deletion, treating an already missing object as deleted. */
export async function ignoreNotFound(
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}
