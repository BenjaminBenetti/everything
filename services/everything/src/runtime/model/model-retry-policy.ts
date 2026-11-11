/**
 * How a model request that failed for a passing reason is tried again in the same turn: at most
 * `maxRetries` more times, waiting `baseDelayMs` before the first retry and twice as long before
 * each later one, never more than `maxDelayMs`.
 */
export interface ModelRetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** Three attempts in all, one second and then two seconds apart. */
export const modelRetryPolicy: ModelRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
};
