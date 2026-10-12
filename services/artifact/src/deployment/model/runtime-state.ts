import type { ArtifactRuntime } from "@everything/artifact-contracts";

/** What matters about one pod for an artifact's runtime status. */
export interface PodObservation {
  readonly phase: string;
  readonly ready: boolean;
  readonly restarts: number;
  /** Reason the app container is waiting, such as `CrashLoopBackOff`, or null. */
  readonly waitingReason: string | null;
}

/** Waiting reasons that will not resolve without a change to the artifact. */
const failingReasons = new Set([
  "CrashLoopBackOff",
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
]);

/** Summarize an artifact's pods: running when one is ready, failing when one cannot start. */
export function runtimeFromPods(
  pods: readonly PodObservation[],
): ArtifactRuntime {
  const restarts = pods.reduce((total, pod) => total + pod.restarts, 0);
  if (pods.some((pod) => pod.ready))
    return { state: "running", restarts, reason: null };
  const failing = pods.find(
    (pod) =>
      pod.phase === "Failed" ||
      (pod.waitingReason !== null && failingReasons.has(pod.waitingReason)),
  );
  if (failing)
    return {
      state: "failing",
      restarts,
      reason: failing.waitingReason ?? failing.phase,
    };
  return {
    state: "starting",
    restarts,
    reason: pods.find((pod) => pod.waitingReason)?.waitingReason ?? null,
  };
}
