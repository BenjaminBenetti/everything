import { ApplicationError } from "@everything/errors";

/** The app has no usable API key: the capability is off, or its key is still being set up. */
export class AppApiKeyUnavailableError extends ApplicationError {
  /** Explain how an app gets a key. */
  constructor() {
    super(
      409,
      "APP_API_KEY_UNAVAILABLE",
      "This app doesn't have an API key right now. A teammate can turn on its API Key capability when deploying it. If it's on, try again in a moment.",
    );
  }
}
