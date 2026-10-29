import { ApplicationError } from "@everything/errors";

/** A teammate needs an explicit inference selection before starting work. */
export class ProviderUnavailableError extends ApplicationError {
  /** Ask the owner to select this teammate's provider, model, and effort. */
  constructor() {
    super(
      503,
      "PROVIDER_UNAVAILABLE",
      "Choose a provider, model, and effort level in this teammate’s settings before sending a message.",
    );
  }
}

/** The provider refused a teammate's Fast mode request; the turn ends without retrying at standard speed. */
export class FastModeRejectedError extends ApplicationError {
  /** Ask the owner to turn off Fast mode, since their account or model cannot use it. */
  constructor() {
    super(
      409,
      "FAST_MODE_REJECTED",
      "Your provider didn’t accept Fast mode for this teammate’s model or account. Turn off Fast mode in the teammate’s settings, then send a message to continue.",
    );
  }
}

/** The provider's separate Fast mode limit stopped the request; the turn ends without retrying at standard speed. */
export class FastModeLimitedError extends ApplicationError {
  /** Offer waiting or turning off Fast mode, without choosing standard speed for the owner. */
  constructor() {
    super(
      429,
      "FAST_MODE_LIMITED",
      "Your provider’s Fast mode limit was reached. Wait a moment and send a message again, or turn off Fast mode in the teammate’s settings.",
    );
  }
}

/** A model request ended in an error; its diagnosis is in telemetry, never in the caller's message. */
export class ModelRequestFailedError extends Error {
  /** Keep the message the runtime has always used internally. */
  constructor() {
    super("Pi model request failed");
    this.name = "ModelRequestFailedError";
  }
}

/** Summarizing older context failed, so the turn could not continue. */
export class CompactionFailedError extends Error {
  /** Keep the message the runtime has always used internally. */
  constructor() {
    super("Pi context compaction failed");
    this.name = "CompactionFailedError";
  }
}

/** The teammate finished its turn, and the reminder that followed, without replying. */
export class ReplyNotDeliveredError extends Error {
  /** Keep the message the runtime has always used internally. */
  constructor() {
    super("The teammate did not deliver a reply");
    this.name = "ReplyNotDeliveredError";
  }
}
