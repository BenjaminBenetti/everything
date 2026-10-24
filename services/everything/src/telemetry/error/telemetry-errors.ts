import { ApplicationError } from "@everything/errors";

/** The installation runs without a telemetry backend. */
export class TelemetryDisabledError extends ApplicationError {
  /** Explain that there is nothing to search. */
  constructor() {
    super(
      503,
      "TELEMETRY_DISABLED",
      "Telemetry is turned off for this installation, so there’s nothing to search.",
    );
  }
}

/** The telemetry backend did not answer or refused the request. */
export class TelemetryUnavailableError extends ApplicationError {
  /** Ask the caller to try again, without exposing the backend's reason. */
  constructor() {
    super(
      503,
      "TELEMETRY_UNAVAILABLE",
      "Telemetry storage isn’t responding right now. Try again in a moment.",
    );
  }
}

/** The record or trace does not exist for this owner, or has passed the retention period. */
export class TelemetryRecordNotFoundError extends ApplicationError {
  /** Treat missing and inaccessible records the same way. */
  constructor() {
    super(
      404,
      "TELEMETRY_NOT_FOUND",
      "This telemetry record isn’t available. It may be older than the retention period.",
    );
  }
}

/** The requested time range is reversed or entirely outside the retention period. */
export class InvalidTelemetryRangeError extends ApplicationError {
  /** Explain what a valid range is. */
  constructor(retentionDays: number) {
    super(
      400,
      "INVALID_TELEMETRY_RANGE",
      `Choose a start time before the end time, within the last ${retentionDays} days.`,
    );
  }
}

/** A page cursor that the API did not issue. */
export class InvalidTelemetryCursorError extends ApplicationError {
  /** Ask the caller to start from the first page. */
  constructor() {
    super(
      400,
      "INVALID_TELEMETRY_CURSOR",
      "This page link is no longer valid. Refresh to start from the newest records.",
    );
  }
}

/** The backend's error code for a query naming a column its stream does not have. */
export const unknownTelemetryField = 20004;

/** The telemetry backend refused a query or could not be reached; never shown to callers. */
export class TelemetrySearchError extends Error {
  /** Keep the backend's numeric code, when it gave one, for the caller's decision. */
  constructor(readonly code?: number) {
    super("Telemetry search failed");
    this.name = "TelemetrySearchError";
  }
}
