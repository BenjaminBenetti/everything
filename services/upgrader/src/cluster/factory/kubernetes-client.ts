import {
  AuthenticationV1Api,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
} from "@kubernetes/client-node";

/** Kubernetes API clients sharing one configuration. */
export interface KubernetesClients {
  readonly core: CoreV1Api;
  readonly batch: BatchV1Api;
  readonly authentication: AuthenticationV1Api;
}

/** Connect with the pod's service account in the cluster, or the local kubeconfig elsewhere. */
export function createKubernetesClients(): KubernetesClients {
  const config = new KubeConfig();
  config.loadFromDefault();
  return {
    core: config.makeApiClient(CoreV1Api),
    batch: config.makeApiClient(BatchV1Api),
    authentication: config.makeApiClient(AuthenticationV1Api),
  };
}
