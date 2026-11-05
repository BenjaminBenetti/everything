import { ApplicationError } from "@everything/errors";
import { jobLimits } from "./job.js";

/** Bounded retry for wakeups refused because the teammate's background slots were full. */
export interface JobDispatchPolicy {
  readonly retries: number;
  readonly minRetryMs: number;
  readonly maxRetryMs: number;
}

/** Retry a full family for about a minute; other refusals end the run at once. */
export const defaultJobDispatchPolicy: JobDispatchPolicy = {
  retries: 3,
  minRetryMs: 5_000,
  maxRetryMs: 30_000,
};

/** The task attribution a job run's background session sees. */
export const jobWakeupSource = "scheduled job";

/** Safe operational reasons recorded on runs; none contain provider responses or transcripts. */
export const jobRunErrors = {
  turnFailed:
    "The run couldn't finish. Check the model provider, then use Run now to try again.",
  stopped: "Stopped before it finished.",
  stoppedFromJob: "Stopped from the job before it finished.",
  pausedBeforeStart: "The job was paused before this run started.",
  shutdown: "Everything shut down before this run finished; it wasn't retried.",
  restarted:
    "Everything restarted before this run finished, so it stopped and wasn't retried.",
  unexpected: "Didn't start because of an unexpected error.",
} as const;

/** Refusals that happen before a wakeup is accepted, by error code. */
const refusals: Readonly<Record<string, string>> = {
  FORK_LIMIT:
    "Didn't start because this teammate already had eight background tasks running.",
  FORK_UNAVAILABLE:
    "Didn't start because this teammate's work was being stopped.",
  PROVIDER_UNAVAILABLE:
    "Didn't start because this teammate has no model selected. Choose a provider, model, and effort level in its settings.",
  PROVIDER_INACTIVE:
    "Didn't start because this teammate's model provider isn't connected. Reconnect it in Model providers.",
  SHUTTING_DOWN: "Didn't start because Everything was shutting down.",
  SUBAGENTS_UNAVAILABLE:
    "Didn't start because background work is unavailable for this teammate.",
  AGENT_NOT_FOUND: "Didn't start because the teammate wasn't found.",
};

/** Only a full family is worth retrying: nothing was accepted, and a slot frees as other work ends. */
export function retryableRefusal(error: unknown): boolean {
  return error instanceof ApplicationError && error.code === "FORK_LIMIT";
}

/** Explain a refused wakeup with known recovery text, or the caller-safe message of other refusals. */
export function refusalText(error: unknown): string {
  if (!(error instanceof ApplicationError)) return jobRunErrors.unexpected;
  return (
    refusals[error.code] ??
    `Didn't start: ${error.message}`.slice(0, jobLimits.errorLength)
  );
}
