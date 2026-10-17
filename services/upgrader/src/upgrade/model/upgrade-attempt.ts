import type { V1Job } from "@kubernetes/client-node";
import type { UpgradeAttempt } from "@everything/upgrade-contracts";
import {
  fromVersionAnnotation,
  toVersionAnnotation,
  upgradeDeadlineSeconds,
} from "./upgrade-job-manifest.js";

/** Failure explanations are cut to this length; Helm's first error line carries the reason. */
const failureMaxLength = 1000;

/**
 * The upgrade a Job records, or null for a Job without the versions. `failure` is the upgrade
 * container's termination message: Helm's error, or the end of its output.
 */
export function upgradeAttempt(
  job: V1Job,
  failure: string | undefined,
): UpgradeAttempt | null {
  const annotations = job.metadata?.annotations ?? {};
  const fromVersion = annotations[fromVersionAnnotation];
  const toVersion = annotations[toVersionAnnotation];
  const created = job.metadata?.creationTimestamp;
  if (!fromVersion || !toVersion || !created) return null;
  const startedAt = new Date(created).toISOString();
  const condition = (type: string) =>
    job.status?.conditions?.find(
      (candidate) => candidate.type === type && candidate.status === "True",
    );
  const complete = condition("Complete");
  if (complete)
    return {
      fromVersion,
      toVersion,
      state: "succeeded",
      startedAt,
      finishedAt: timestamp(
        job.status?.completionTime ?? complete.lastTransitionTime,
      ),
      failure: null,
    };
  const failed = condition("Failed");
  if (failed)
    return {
      fromVersion,
      toVersion,
      state: "failed",
      startedAt,
      finishedAt: timestamp(failed.lastTransitionTime),
      failure: failureReason(failed.reason, failure),
    };
  return {
    fromVersion,
    toVersion,
    state: "running",
    startedAt,
    finishedAt: null,
    failure: null,
  };
}

/** Explain a failed upgrade with Helm's own words when it left any. */
function failureReason(
  reason: string | undefined,
  message: string | undefined,
): string {
  const text = message?.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (text)
    return text.length > failureMaxLength
      ? `${text.slice(0, failureMaxLength - 1)}…`
      : text;
  if (reason === "DeadlineExceeded")
    return `The upgrade took longer than ${upgradeDeadlineSeconds / 60} minutes and was stopped.`;
  return "The upgrade stopped before it finished.";
}

/** An optional Kubernetes time as an ISO timestamp. */
function timestamp(value: Date | string | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}
