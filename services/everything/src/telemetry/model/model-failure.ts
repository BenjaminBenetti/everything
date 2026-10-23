/**
 * Why a model request did not complete, in terms an owner can act on. `cancelled` is not a failure:
 * someone stopped the work.
 */
export const modelFailureCategories = [
  "cancelled",
  "rate_limit",
  "quota",
  "overloaded",
  "unavailable",
  "server_error",
  "timeout",
  "network",
  "stream_interrupted",
  "authentication",
  "permission",
  "not_found",
  "context_length",
  "request_too_large",
  "invalid_request",
  "content_filter",
  "fast_mode_rejected",
  "fast_mode_limited",
  "unknown",
] as const;
export type ModelFailureCategory = (typeof modelFailureCategories)[number];

/** The HTTP response a provider gave one attempt of a model request, without its body. */
export interface ProviderResponseRecord {
  readonly attempt: number;
  readonly status: number;
  readonly requestId?: string;
  /** The provider's own error type or code from the response body, such as `rate_limit_error`. */
  readonly errorType?: string;
  /** A redacted excerpt of the provider's error message from the response body. */
  readonly errorMessage?: string;
  readonly retryAfter?: string;
}

/** What the runtime knows when a model request ends without a usable response. */
export interface ModelFailureInput {
  readonly stopReason: "error" | "aborted";
  /** The message Pi recorded, typically the provider SDK's error message. */
  readonly errorMessage?: string;
  /** The last HTTP response the provider gave during the request, if any. */
  readonly lastResponse?: ProviderResponseRecord;
  /** A refused Fast mode request, which has its own recovery. */
  readonly speedFailure?: "rejected" | "limited";
}

/** A model failure's safe diagnosis. */
export interface ModelFailure {
  readonly category: ModelFailureCategory;
  readonly code?: string;
  readonly httpStatus?: number;
  readonly requestId?: string;
  /** Whether sending the message again later may succeed without changing anything. */
  readonly retryable: boolean;
  /**
   * A redacted, bounded excerpt of the provider's or SDK's own error message, never other fields
   * of an error body. It can still quote what was sent, so it is exported only when the
   * installation records error text.
   */
  readonly message?: string;
}
