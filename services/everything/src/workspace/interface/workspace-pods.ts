/** Desired-state operations needed by reconciliation, independent of Kubernetes. */
export interface WorkspacePods {
  /** List identities managed by this controller, including partial creations. */
  list(): Promise<readonly string[]>;
  /** Create or update a singleton workload and its internal API address. */
  ensure(agentId: string): Promise<void>;
  /** Stop the pod and wait until it cannot write files before returning. */
  remove(agentId: string): Promise<void>;
}
