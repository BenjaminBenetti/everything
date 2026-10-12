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
