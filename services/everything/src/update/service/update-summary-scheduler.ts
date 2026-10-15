import type { UpdateSummaryStore } from "../interface/update-repository.js";
import type { UpdateSummarizer } from "../interface/update-summarizer.js";
import {
  summaryGraceMs,
  type UpdateSummaryTarget,
} from "../model/update-summary.js";

/** Generate cached summaries independently of browsers with bounded work in the singleton API. */
export class UpdateSummaryScheduler {
  // ===========================================
  // Construction and state
  // ===========================================

  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private readonly cancellation = new AbortController();

  /** Keep durable claims, model calls, and safe operational reporting separate. */
  constructor(
    private readonly updates: UpdateSummaryStore,
    private readonly summarizer: UpdateSummarizer,
    private readonly reportFailure: () => void,
  ) {}

  // ===========================================
  // Lifecycle
  // ===========================================

  /** Catch up on startup, then check for new updates without involving feed polling. */
  start(): void {
    if (this.timer || this.cancellation.signal.aborted) return;
    this.timer = setInterval(() => void this.refresh(), 5_000);
    this.timer.unref();
    void this.refresh();
  }

  /** Abort active inference and drain its result before the database closes. */
  async close(): Promise<void> {
    this.cancellation.abort();
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Coalesce concurrent ticks; durable claims also protect against another process claiming the same row. */
  refresh(): Promise<void> {
    if (this.cancellation.signal.aborted) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.generateDue()
      .catch(() => this.reportFailure())
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  // ===========================================
  // Generation
  // ===========================================

  /** Give active readers time to send receipts, and allow at most two simultaneous model calls. */
  private async generateDue(): Promise<void> {
    const targets = await this.updates.pendingSummaries({
      createdBefore: new Date(Date.now() - summaryGraceMs),
    });
    for (
      let index = 0;
      index < targets.length && !this.cancellation.signal.aborted;
      index += 2
    )
      await Promise.all(
        targets.slice(index, index + 2).map((target) => this.generate(target)),
      );
  }

  /** A failed or interrupted attempt is cached as unavailable; never retry a potentially billed request. */
  private async generate(target: UpdateSummaryTarget): Promise<void> {
    const scope = { ownerId: target.ownerId };
    try {
      const update = await this.updates.claimSummary(scope, target.id);
      if (!update) return;
      let summary: string | null = null;
      try {
        summary = await this.summarizer.summarize(
          update,
          this.cancellation.signal,
        );
      } catch {
        this.reportFailure();
      }
      await this.updates.finishSummary(scope, target.id, summary);
    } catch {
      this.reportFailure();
    }
  }
}
