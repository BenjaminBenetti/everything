import type { V1JobCondition, V1Pod } from "@kubernetes/client-node";
import {
  ignoreNotFound,
  isNotFound,
  type KubernetesClients,
} from "../../cluster/factory/kubernetes-client.js";
import { buildJobName } from "../../cluster/model/cluster-names.js";
import type {
  BuildJob,
  BuildProgress,
  BuildRunner,
} from "../interface/build-runner.js";
import {
  buildDeadlineSeconds,
  buildJobManifest,
  type BuildkitSettings,
} from "./build-job-manifest.js";

/** Explain a failed Job condition in terms a main agent can act on. */
function failureReason(condition: V1JobCondition | undefined): string {
  if (condition?.reason === "DeadlineExceeded")
    return `The build took longer than ${buildDeadlineSeconds / 60} minutes and was stopped.`;
  return "The build failed. Read its log for details.";
}

/** Runs each build as a Kubernetes Job with rootless BuildKit. */
export class BuildkitJobRunner implements BuildRunner {
  // ===========================================
  // Construction
  // ===========================================

  /** Use the batch and core APIs in the configured build namespace. */
  constructor(
    private readonly clients: Pick<KubernetesClients, "batch" | "core">,
    private readonly settings: BuildkitSettings,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Create the build's Job. */
  async start(job: BuildJob): Promise<void> {
    await this.clients.batch.createNamespacedJob({
      namespace: this.settings.namespace,
      body: buildJobManifest(job, this.settings),
    });
  }

  /** Read the Job's status; a missing Job is reported rather than thrown. */
  async progress(buildId: string): Promise<BuildProgress> {
    let status;
    try {
      status = (
        await this.clients.batch.readNamespacedJob({
          name: buildJobName(buildId),
          namespace: this.settings.namespace,
        })
      ).status;
    } catch (error) {
      if (isNotFound(error)) return { phase: "missing", reason: null };
      throw error;
    }
    if ((status?.succeeded ?? 0) > 0)
      return { phase: "succeeded", reason: null };
    const failed = status?.conditions?.find(
      (condition) => condition.type === "Failed" && condition.status === "True",
    );
    if (failed || (status?.failed ?? 0) > 0)
      return { phase: "failed", reason: failureReason(failed) };
    return {
      phase: (status?.active ?? 0) > 0 ? "running" : "pending",
      reason: null,
    };
  }

  /** Read the end of the step that ran last: the source download if it failed, else the build. */
  async log(buildId: string, limit: number): Promise<string> {
    const pod = await this.latestPod(buildId);
    if (!pod?.metadata?.name) return "";
    const source = pod.status?.initContainerStatuses?.find(
      (container) => container.name === "source",
    );
    const sourceFailed = (source?.state?.terminated?.exitCode ?? 0) !== 0;
    const container = sourceFailed ? "source" : "buildkit";
    const started = pod.status?.containerStatuses?.some(
      (status) => status.name === container && !status.state?.waiting,
    );
    if (!sourceFailed && !started) return "";
    try {
      return await this.clients.core.readNamespacedPodLog({
        name: pod.metadata.name,
        namespace: this.settings.namespace,
        container,
        limitBytes: limit,
      });
    } catch (error) {
      if (isNotFound(error)) return "";
      throw error;
    }
  }

  /** Delete the Job and its pod. */
  async remove(buildId: string): Promise<void> {
    await ignoreNotFound(() =>
      this.clients.batch.deleteNamespacedJob({
        name: buildJobName(buildId),
        namespace: this.settings.namespace,
        propagationPolicy: "Background",
      }),
    );
  }

  // ===========================================
  // Pods
  // ===========================================

  /** The Job's most recently created pod. */
  private async latestPod(buildId: string): Promise<V1Pod | undefined> {
    const pods = await this.clients.core.listNamespacedPod({
      namespace: this.settings.namespace,
      labelSelector: `batch.kubernetes.io/job-name=${buildJobName(buildId)}`,
    });
    return pods.items
      .slice()
      .sort(
        (a, b) =>
          (b.metadata?.creationTimestamp?.getTime() ?? 0) -
          (a.metadata?.creationTimestamp?.getTime() ?? 0),
      )[0];
  }
}
