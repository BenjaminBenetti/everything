import AsyncLock from "async-lock";
import pRetry from "p-retry";
import { ApplicationError } from "@everything/errors";
import type {
  SubagentOperations,
  WakeupObserver,
  WakeupOutcome,
} from "../../subagent/interface/subagent-operations.js";
import type { JobRunStore } from "../interface/job-repository.js";
import {
  allJobs,
  type ClaimedJobRun,
  type JobOwnerScope,
  type JobRunFinish,
} from "../model/job.js";
import {
  defaultJobDispatchPolicy,
  jobRunErrors,
  jobWakeupSource,
  refusalText,
  retryableRefusal,
  type JobDispatchPolicy,
} from "../model/job-dispatch.js";
import { jobRunPrompt } from "../prompt/job-run-prompt.js";

/** Job runs use the same owner-scoped wakeup and deletion as API events and monitors. */
export type JobWakeups = Pick<SubagentOperations, "wakeup" | "delete">;

/** A run this process dispatched and still follows. */
interface ActiveRun {
  readonly runId: string;
  readonly scope: JobOwnerScope;
  /** Withdraws the wakeup until the teammate accepts it. */
  readonly withdrawal: AbortController;
  /** The temporary background session, once accepted. */
  forkId: string | undefined;
  startedAt: string | undefined;
  /** Why an owner action or shutdown ended the run, recorded instead of a generic reason. */
  reason: string | undefined;
  finished: boolean;
  /** The run's writes in order, so its ending is never recorded before its start. */
  writes: Promise<void>;
}

/**
 * Dispatch claimed runs through the teammate's normal wakeup and record their operational lifecycle
 * from the runtime's own signals: running when the temporary session accepts the task, and
 * completed, failed, or cancelled when that session is removed. Acceptance is never treated as
 * completion. A wakeup refused before acceptance because the family is full is retried briefly;
 * every other refusal ends the run, and nothing that may have been accepted is ever sent twice.
 * Following lives in this process; after a restart, interrupted runs are failed, not replayed.
 */
export class JobRuns {
  // ===========================================
  // Construction and state
  // ===========================================

  private readonly active = new Map<string, ActiveRun>();
  private readonly lock = new AsyncLock();
  private readonly work = new Set<Promise<unknown>>();
  private closing = false;

  /** Receive the wakeup path, run storage, failure reporting, retry policy, and a clock. */
  constructor(
    private readonly wakeups: JobWakeups,
    private readonly store: JobRunStore,
    private readonly reportFailure: () => void,
    private readonly policy: JobDispatchPolicy = defaultJobDispatchPolicy,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ===========================================
  // Coordination
  // ===========================================

  /**
   * Serialize claiming, editing, and deleting one job, so a pause or deletion always sees a run
   * claimed before it and a claim always sees a pause committed before it.
   */
  guard<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    return this.lock.acquire(`job:${jobId}`, operation);
  }

  /** Start a claimed run without waiting for acceptance or completion. */
  dispatch(claimed: ClaimedJobRun): void {
    const entry: ActiveRun = {
      runId: claimed.run.id,
      scope: { ownerId: claimed.ownerId, agentId: claimed.job.agentId },
      withdrawal: new AbortController(),
      forkId: undefined,
      startedAt: undefined,
      reason: undefined,
      finished: false,
      writes: Promise.resolve(),
    };
    this.active.set(claimed.job.id, entry);
    if (this.closing) this.withdrawEntry(entry, jobRunErrors.shutdown);
    this.track(this.start(claimed, entry));
  }

  /** Pausing withdraws a run the teammate hasn't accepted yet; a running one continues. */
  withdraw(jobId: string): void {
    const entry = this.active.get(jobId);
    if (entry && entry.forkId === undefined)
      this.withdrawEntry(entry, jobRunErrors.pausedBeforeStart);
  }

  /** Stop the job's current run, removing only its own background subtree. */
  async cancel(jobId: string, reason: string): Promise<void> {
    const entry = this.active.get(jobId);
    if (!entry) return;
    this.withdrawEntry(entry, reason);
    if (entry.forkId !== undefined) await this.remove(entry);
  }

  // ===========================================
  // Lifecycle
  // ===========================================

  /** Refuse new runs and withdraw unaccepted ones; accepted runs end when their runtime closes. */
  async close(): Promise<void> {
    this.closing = true;
    for (const entry of this.active.values())
      if (entry.forkId === undefined)
        this.withdrawEntry(entry, jobRunErrors.shutdown);
    await this.settled();
  }

  /** Wait for dispatches and run writes, including endings reported while runtimes close. */
  async settled(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  // ===========================================
  // Dispatch
  // ===========================================

  /** Request one wakeup, retrying only a full family, then honor a cancellation that raced acceptance. */
  private async start(claimed: ClaimedJobRun, entry: ActiveRun): Promise<void> {
    const { signal } = entry.withdrawal;
    try {
      signal.throwIfAborted();
      await pRetry(
        () =>
          this.wakeups.wakeup(
            entry.scope,
            { task: jobRunPrompt(claimed), context: false },
            signal,
            {
              source: jobWakeupSource,
              observer: this.observer(claimed.job.id, entry),
            },
          ),
        {
          retries: this.policy.retries,
          minTimeout: this.policy.minRetryMs,
          maxTimeout: this.policy.maxRetryMs,
          signal,
          shouldRetry: ({ error }) => retryableRefusal(error),
        },
      );
    } catch (error) {
      // Without an acceptance, the teammate didn't take the run. With one, the withdrawal arrived
      // while the wakeup was in flight, and p-retry reported it after the success.
      if (entry.forkId === undefined) {
        this.finish(
          claimed.job.id,
          entry,
          entry.reason ? "cancelled" : "failed",
          entry.reason ?? refusalText(error),
        );
        return;
      }
    }
    if (entry.reason) await this.remove(entry);
  }

  /** Bind the runtime's acceptance and removal signals to this run. */
  private observer(jobId: string, entry: ActiveRun): WakeupObserver {
    return {
      accepted: (forkId) => {
        entry.forkId = forkId;
        const startedAt = this.clock().toISOString();
        entry.startedAt = startedAt;
        this.write(entry, () =>
          this.store.markRunning(allJobs, entry.runId, startedAt),
        );
      },
      finished: (outcome) =>
        this.finish(jobId, entry, outcome, this.reasonFor(outcome, entry)),
    };
  }

  /** A completed run needs no reason; others say why without exposing provider details. */
  private reasonFor(outcome: WakeupOutcome, entry: ActiveRun): string | null {
    switch (outcome) {
      case "completed":
        return null;
      case "failed":
        return jobRunErrors.turnFailed;
      case "cancelled":
        return (
          entry.reason ??
          (this.closing ? jobRunErrors.shutdown : jobRunErrors.stopped)
        );
    }
  }

  /** Record the ending once and stop following the run. */
  private finish(
    jobId: string,
    entry: ActiveRun,
    status: JobRunFinish["status"],
    error: string | null,
  ): void {
    if (entry.finished) return;
    entry.finished = true;
    if (this.active.get(jobId) === entry) this.active.delete(jobId);
    const finish: JobRunFinish = {
      status,
      finishedAt: this.clock().toISOString(),
      startedAt: entry.startedAt ?? null,
      error,
    };
    this.write(entry, () => this.store.finishRun(allJobs, entry.runId, finish));
  }

  // ===========================================
  // Helpers
  // ===========================================

  /** Abort a wakeup that hasn't been accepted, keeping the first reason given. */
  private withdrawEntry(entry: ActiveRun, reason: string): void {
    entry.reason ??= reason;
    entry.withdrawal.abort();
  }

  /** Delete the run's background subtree; its removal reports the ending through the observer. */
  private async remove(entry: ActiveRun): Promise<void> {
    try {
      await this.wakeups.delete(entry.scope, entry.forkId!);
    } catch (error) {
      // Already removed, or the teammate is stopping; either way the observer reports the end.
      if (!(error instanceof ApplicationError)) this.reportFailure();
    }
  }

  /** Append a store write with a short retry, so a passing database error doesn't strand the run. */
  private write(entry: ActiveRun, operation: () => Promise<void>): void {
    entry.writes = entry.writes
      .then(() => pRetry(operation, { retries: 2, minTimeout: 200 }))
      .catch(() => this.reportFailure());
    this.track(entry.writes);
  }

  /** Remember outstanding work so shutdown can wait for it. */
  private track(promise: Promise<unknown>): void {
    this.work.add(promise);
    const forget = () => this.work.delete(promise);
    void promise.then(forget, forget);
  }
}
