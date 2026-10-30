import type { AttachmentExpiry } from "./attachment-expiry.js";
import { attachmentRetention } from "../model/attachment-file.js";

/**
 * Remove expired attachments after startup and on an interval, with one running pass in the
 * singleton API, so abandoned uploads never hold workspace space for long after a restart.
 */
export class AttachmentExpiryScheduler {
  // ===========================================
  // Construction and state
  // ===========================================

  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  /** Depend on the expiry pass; report failures without their details. */
  constructor(
    private readonly expiry: Pick<AttachmentExpiry, "expire">,
    private readonly reportFailure: () => void,
  ) {}

  // ===========================================
  // Lifecycle
  // ===========================================

  /** Catch up after startup, then expire on an interval without overlapping passes. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(
      () => void this.refresh(),
      attachmentRetention.sweepIntervalMs,
    );
    this.timer.unref();
    void this.refresh();
  }

  /** Finish the current pass before the application closes its database. */
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
    this.running = this.expiry
      .expire()
      .catch(() => this.reportFailure())
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
