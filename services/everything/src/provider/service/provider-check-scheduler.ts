import { providerLimits } from "@everything/provider-contracts";
import type { ProviderCheckSource } from "../interface/provider-check-repository.js";
import type { ProviderChecks } from "../interface/provider-checks.js";

/** Refresh due connections independently of browsers, with one running batch in the singleton API. */
export class ProviderCheckScheduler {
  // ===========================================
  // Construction and state
  // ===========================================

  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  /** Depend on due identities and scoped checks; report operational failures without exposing secrets. */
  constructor(
    private readonly source: ProviderCheckSource,
    private readonly checks: ProviderChecks,
    private readonly reportFailure: () => void,
  ) {}

  // ===========================================
  // Lifecycle
  // ===========================================

  /** Catch up after startup and poll persisted due times once a minute without overlapping batches. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.refresh(), 60_000);
    this.timer.unref();
    void this.refresh();
  }

  /** Drain the current request before the application closes its database. */
  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Coalesce simultaneous ticks and expose a completion boundary for lifecycle checks. */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.checkDue()
      .catch(() => this.reportFailure())
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /** Revalidate each due record under the connection service's owner/provider lock. */
  private async checkDue(): Promise<void> {
    const targets = await this.source.list({
      checkedBefore: new Date(
        Date.now() - providerLimits.verificationIntervalMs,
      ),
    });
    for (const target of targets) {
      if (this.stopped) break;
      try {
        await this.checks.verifyIfDue(target.ownerId, target.provider);
      } catch {
        this.reportFailure();
      }
    }
  }
}
