import { ApplicationError } from "@everything/errors";

/** An app response contains a private credential or cannot be safely inspected. */
export class AppResponseBlockedError extends ApplicationError {
  /** Keep response data and credential values out of errors and logs. */
  constructor() {
    super(
      502,
      "APP_RESPONSE_BLOCKED",
      "The app response could not be safely forwarded.",
    );
  }
}
