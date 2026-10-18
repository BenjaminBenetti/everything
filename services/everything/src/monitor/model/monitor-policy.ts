/** Public tool identifiers shared by prompts and Pi bindings. */
export const monitorToolNames = {
  start: "monitor",
  list: "list_monitors",
  stop: "stop_monitor",
} as const;

/** Longest instructions a monitor can carry into its completion event. */
export const monitorInstructionsMaxLength = 2000;

/** Timing for following a pod's monitor and delivering its completion event. */
export interface MonitorDeliveryPolicy {
  /** Report a monitor as lost after its pod has been unreachable this long; the pod stops it sooner. */
  readonly unreachableMs: number;
  /** Pause between wait requests after a failure. */
  readonly waitRetryMs: number;
  /** Bounded backoff for wakeups refused at capacity or while inference is unavailable. */
  readonly retries: number;
  readonly minRetryMs: number;
  readonly maxRetryMs: number;
}

/** Retry wakeups for about four minutes, enough for running forks to free a slot. */
export const defaultMonitorDeliveryPolicy: MonitorDeliveryPolicy = {
  unreachableMs: 120_000,
  waitRetryMs: 2_000,
  retries: 7,
  minRetryMs: 2_000,
  maxRetryMs: 60_000,
};
