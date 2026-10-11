import { ApplicationError } from "@everything/errors";

/** No model provider has credentials, so no agent can run. */
export class ProviderUnavailableError extends ApplicationError {
  /** Ask the user to connect a provider. */
  constructor() {
    super(
      503,
      "PROVIDER_UNAVAILABLE",
      "Connect a model provider to use your teammates.",
    );
  }
}
