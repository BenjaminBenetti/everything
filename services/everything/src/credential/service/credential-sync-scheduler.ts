import type { CredentialRollouts } from "./credential-rollouts.js";

/** How often stored credentials are compared with what apps hold. */
export const credentialSyncIntervalMs = 30_000;

/**
 * Retry credential deliveries and revocations independently of browsers, with one running pass in
 * the singleton API, so a failure or restart midway never leaves an app with a stale or revoked
 * credential for longer than one interval after the app service answers again.
 */
export class CredentialSyncScheduler {
  // ===========================================
  // Construction and state
  // ===========================================

  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  /** Depend on the rollout use cases; report failures without their details. */
  constructor(
    private readonly rollouts: Pick<CredentialRollouts, "synchronize">,
    private readonly reportFailure: () => void,
  ) {}

  // ===========================================
  // Lifecycle
  // ===========================================

  /** Catch up after startup, then synchronize on an interval without overlapping passes. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(
      () => void this.refresh(),
      credentialSyncIntervalMs,
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
    this.running = this.rollouts
      .synchronize()
      .catch(() => this.reportFailure())
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
