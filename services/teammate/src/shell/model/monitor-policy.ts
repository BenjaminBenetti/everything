/** How long monitors live without a waiting caller, and how long finished results stay readable. */
export interface MonitorPolicy {
  /** Stop a running command when no caller has waited for it this long, such as after Everything crashed. */
  readonly leaseMs: number;
  /** Forget a finished command's result after this long; its log file remains. */
  readonly retentionMs: number;
  /** How often expired leases and results are checked. */
  readonly sweepMs: number;
}

/** Leases outlast several missed wait requests; results outlast a caller's retries. */
export const defaultMonitorPolicy: MonitorPolicy = {
  leaseMs: 90_000,
  retentionMs: 10 * 60_000,
  sweepMs: 5_000,
};
