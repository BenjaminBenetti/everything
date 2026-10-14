import type { MessageSummaryStore } from "../interface/message-summary-store.js";
import type { MessageSummarizer } from "../interface/message-summarizer.js";
import type { MessageSummaryTarget } from "../model/message-summary.js";

/** Generate cached summaries independently of browsers with bounded work in the singleton API. */
export class MessageSummaryScheduler {
  // ===========================================
  // Construction and state
  // ===========================================

  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private readonly cancellation = new AbortController();

  /** Keep public-message claims, model calls, and safe operational reporting separate. */
  constructor(
    private readonly messages: MessageSummaryStore,
    private readonly summarizer: MessageSummarizer,
    private readonly reportFailure: () => void,
  ) {}

  // ===========================================
  // Lifecycle
  // ===========================================

  /** Catch up on startup, then check for unread deliveries without involving feed polling. */
  start(): void {
    if (this.timer || this.cancellation.signal.aborted) return;
    this.timer = setInterval(() => void this.refresh(), 5_000);
    this.timer.unref();
    void this.refresh();
  }

  /** Abort active inference and drain its receipt before the database closes. */
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

  /** Give active readers time to send receipts, and allow at most two simultaneous model calls. */
  private async generateDue(): Promise<void> {
    const targets = await this.messages.pendingSummaries({
      createdBefore: new Date(Date.now() - 1_500),
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
  private async generate(target: MessageSummaryTarget): Promise<void> {
    const scope = { ownerId: target.ownerId, agentId: target.agentId };
    try {
      const message = await this.messages.claimSummary(scope, target.id);
      if (!message) return;
      let summary: string | null = null;
      try {
        summary = await this.summarizer.summarize(
          message,
          this.cancellation.signal,
        );
      } catch {
        this.reportFailure();
      }
      await this.messages.finishSummary(scope, target.id, summary);
    } catch {
      this.reportFailure();
    }
  }
}
