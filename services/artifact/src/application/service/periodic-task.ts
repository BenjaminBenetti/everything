/** Runs background work on a fixed interval, never overlapping one run with the next. */
export class PeriodicTask {
  // ===========================================
  // State
  // ===========================================

  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> = Promise.resolve();
  private stopped = false;

  // ===========================================
  // Construction
  // ===========================================

  /** Describe the work; it starts only when `start` is called. */
  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly work: () => Promise<void>,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Run now, then again after each interval following the previous run's end. */
  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  /** Stop scheduling and wait for a run in progress to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  // ===========================================
  // Scheduling
  // ===========================================

  /** Schedule the next run; failures are logged and the schedule continues. */
  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.running = this.work()
        .catch((error: unknown) =>
          console.error(`${this.name} failed`, { name: (error as Error).name }),
        )
        .finally(() => {
          if (!this.stopped) this.schedule(this.intervalMs);
        });
    }, delay);
  }
}
