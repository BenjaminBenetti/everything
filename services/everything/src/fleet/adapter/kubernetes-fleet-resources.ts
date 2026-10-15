import type { Metrics } from "@kubernetes/client-node";
import { quantityToScalar } from "@kubernetes/client-node/dist/util.js";
import type { WorkspaceResources } from "@everything/workspace-contracts/instance";
import type { FleetResources } from "../interface/fleet-resources.js";

/** Measure Fleet pods only in the namespace supplied by the installation. */
export class KubernetesFleetResources implements FleetResources {
  // ===========================================
  // Construction
  // ===========================================

  /** Accept only the metrics capability needed to read namespaced pod usage. */
  constructor(
    private readonly metrics: Pick<Metrics, "getPodMetrics">,
    private readonly namespace: string,
  ) {}

  // ===========================================
  // Resource measurements
  // ===========================================

  /** Batch metrics reads and tolerate missing metrics-server or newly started pods. */
  async read(
    containerIds: readonly string[],
  ): Promise<ReadonlyMap<string, WorkspaceResources>> {
    const targets = containerIds.flatMap((id) => {
      const match = /^k8s:.+\/([^/]+)\/([^/@]+)@g[1-9]\d*$/.exec(id);
      return match?.[1] === this.namespace
        ? [{ id, pod: `${match[2]}-0` }]
        : [];
    });
    const usage = new Map<string, WorkspaceResources>();
    if (targets.length === 0) return usage;
    try {
      const { items } = await this.metrics.getPodMetrics(this.namespace);
      for (const target of targets) {
        const pod = items.find(
          (item) =>
            item.metadata.name === target.pod &&
            item.metadata.namespace === this.namespace,
        );
        if (!pod || pod.containers.length === 0) continue;
        const cpuCores = pod.containers.reduce(
          (sum, item) => sum + Number(quantityToScalar(item.usage.cpu)),
          0,
        );
        const memoryBytes = pod.containers.reduce(
          (sum, item) => sum + Number(quantityToScalar(item.usage.memory)),
          0,
        );
        usage.set(target.id, {
          cpuCores:
            Number.isFinite(cpuCores) && cpuCores >= 0 ? cpuCores : null,
          memoryBytes:
            Number.isFinite(memoryBytes) && memoryBytes >= 0
              ? memoryBytes
              : null,
        });
      }
    } catch {
      // Metrics availability must not prevent listing or controlling workspaces.
    }
    return usage;
  }
}
