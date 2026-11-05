import type { JobSchedulerStore } from "../interface/job-repository.js";
import { allJobs } from "../model/job.js";
import { jobRunErrors } from "../model/job-dispatch.js";
import { advanceAfterClaim } from "../model/job-schedule.js";
import type { JobRuns } from "./job-runs.js";

/** Most due jobs one check claims; the rest wait for the next check. */
const dueBatchSize = 20;

/**
 * Run due jobs from their persisted next times, independently of browsers, in the singleton API.
 * Each check claims at most one occurrence per due job: missed occurrences are coalesced into one
 * run and the job moves to its next future time, so downtime never causes a flood of replays.
 */
export class JobScheduler {
  // ===========================================
  // Construction and state
  // ===========================================

  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  /** Depend on due-job storage and the dispatcher; report operational failures without details. */
  constructor(
    private readonly store: JobSchedulerStore,
    private readonly runs: Pick<JobRuns, "guard" | "dispatch">,
    private readonly reportFailure: () => void,
    private readonly clock: () => Date = () => new Date(),
    private readonly intervalMs = 15_000,
  ) {}

  // ===========================================
  // Lifecycle
  // ===========================================

  /**
   * Before accepting requests, fail runs a previous process left pending or running. Nothing from
   * before a restart can still be running, and none of it is replayed or assumed to have finished.
   */
  recover(): Promise<number> {
    return this.store.interruptActive(
      allJobs,
      this.clock().toISOString(),
      jobRunErrors.restarted,
    );
  }

  /** Catch up after startup, then check persisted due times on an interval without overlap. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref();
    void this.refresh();
  }

  /** Stop checking and wait for the current check before the dispatcher closes. */
  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Coalesce simultaneous ticks and expose a completion boundary for tests and shutdown. */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.runDue()
      .catch(() => this.reportFailure())
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  // ===========================================
  // Claims
  // ===========================================

  /** Claim each due job under its guard and dispatch it after the claim commits. */
  private async runDue(): Promise<void> {
    const now = this.clock();
    const due = await this.store.due(allJobs, now, dueBatchSize);
    for (const { id } of due) {
      if (this.stopped) break;
      try {
        await this.runs.guard(id, async () => {
          const claimed = await this.store.claim(allJobs, id, now, (job) =>
            advanceAfterClaim(job, now),
          );
          if (claimed) this.runs.dispatch(claimed);
        });
      } catch {
        this.reportFailure();
      }
    }
  }
}
