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
