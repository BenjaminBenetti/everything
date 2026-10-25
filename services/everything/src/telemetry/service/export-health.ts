import type { TelemetryExportHealth } from "@everything/telemetry-contracts";

/**
 * What this process has managed to send to telemetry storage since it started: when the last batch
 * succeeded and failed, how many batches failed, and how many records were discarded, by the
 * bounded export queues or because they couldn't be made safe. Holds counts and times only, never
 * record contents or backend responses.
 */
export class ExportHealth {
  // ===========================================
  // State and construction
  // ===========================================

  private lastSuccess: number | null = null;
  private lastFailure: number | null = null;
  private failures = 0;
  private dropped = 0;
  private failing = false;

  /**
   * Read wall-clock time from `now`, and tell `onChange` when exports start failing and when they
   * recover, so operators see one line per outage rather than one per batch.
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly onChange: (
      state: "failing" | "recovered",
    ) => void = () => {},
  ) {}

  // ===========================================
  // Recording
  // ===========================================

  /** A batch reached the backend. */
  succeeded(): void {
    this.lastSuccess = this.now();
    if (this.failing) {
      this.failing = false;
      this.onChange("recovered");
    }
  }

  /** A batch was refused, timed out, or could not be sent. */
  failed(): void {
    this.lastFailure = this.now();
    this.failures++;
    if (!this.failing) {
      this.failing = true;
      this.onChange("failing");
    }
  }

  /** Records discarded: by a full export queue, or because one couldn't be made safe to hold. */
  discarded(count: number): void {
    if (Number.isFinite(count) && count > 0) this.dropped += count;
  }

  // ===========================================
  // Reporting
  // ===========================================

  /** The counts and times as the status API reports them. */
  snapshot(): TelemetryExportHealth {
    return {
      lastSuccessAt:
        this.lastSuccess === null
          ? null
          : new Date(this.lastSuccess).toISOString(),
      lastFailureAt:
        this.lastFailure === null
          ? null
          : new Date(this.lastFailure).toISOString(),
      failedBatches: this.failures,
      droppedRecords: this.dropped,
    };
  }
}
