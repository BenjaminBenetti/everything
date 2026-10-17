import type { V1Job } from "@kubernetes/client-node";
import type { UpgradeAttempt } from "@everything/upgrade-contracts";
import type { KubernetesClients } from "../../cluster/factory/kubernetes-client.js";
import type { UpgradeJobs, UpgradeRequest } from "../interface/upgrade-jobs.js";
import { upgradeAttempt } from "../model/upgrade-attempt.js";
import {
  upgradeComponent,
  upgradeJobManifest,
  upgradeJobSelector,
} from "../model/upgrade-job-manifest.js";

/** Where the upgrader runs and which release it upgrades. */
export interface UpgradeJobSettings {
  readonly namespace: string;
  readonly release: string;
  /** The upgrader's own pod, whose image, account, and volumes each Job copies. */
  readonly podName: string;
}

/** Runs each upgrade as a Kubernetes Job in the release's namespace. */
export class KubernetesUpgradeJobs implements UpgradeJobs {
  // ===========================================
  // Construction
  // ===========================================

  /** Use the batch and core APIs in the release's namespace. */
  constructor(
    private readonly clients: Pick<KubernetesClients, "batch" | "core">,
    private readonly settings: UpgradeJobSettings,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Describe the newest upgrade Job, with Helm's error when it failed. */
  async latest(): Promise<UpgradeAttempt | null> {
    const jobs = await this.clients.batch.listNamespacedJob({
      namespace: this.settings.namespace,
      labelSelector: upgradeJobSelector(this.settings.release),
    });
    const job = newest(jobs.items);
    if (!job) return null;
    return upgradeAttempt(job, await this.failureMessage(job));
  }

  /** Create a Job from the upgrader's own pod. */
  async start(request: UpgradeRequest): Promise<void> {
    const pod = await this.clients.core.readNamespacedPod({
      name: this.settings.podName,
      namespace: this.settings.namespace,
    });
    await this.clients.batch.createNamespacedJob({
      namespace: this.settings.namespace,
      body: upgradeJobManifest(pod, request, this.settings.release),
    });
  }

  // ===========================================
  // Pods
  // ===========================================

  /** The termination message of a failed Job's upgrade container, if its pod remains. */
  private async failureMessage(job: V1Job): Promise<string | undefined> {
    const name = job.metadata?.name;
    const failed = job.status?.conditions?.some(
      (condition) => condition.type === "Failed" && condition.status === "True",
    );
    if (!name || !failed) return undefined;
    const pods = await this.clients.core.listNamespacedPod({
      namespace: this.settings.namespace,
      labelSelector: `batch.kubernetes.io/job-name=${name}`,
    });
    for (const pod of pods.items)
      for (const status of pod.status?.containerStatuses ?? [])
        if (
          status.name === upgradeComponent &&
          status.state?.terminated?.message
        )
          return status.state.terminated.message;
    return undefined;
  }
}

/** The most recently created Job. */
function newest(jobs: readonly V1Job[]): V1Job | undefined {
  return jobs
    .slice()
    .sort(
      (a, b) =>
        new Date(b.metadata?.creationTimestamp ?? 0).getTime() -
        new Date(a.metadata?.creationTimestamp ?? 0).getTime(),
    )[0];
}
