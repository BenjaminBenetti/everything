import { ApplicationError } from "@everything/errors";

/** Documentation is unavailable until route registration has completed. */
export class ApiDocumentationUnavailableError extends ApplicationError {
  /** Keep initialization details private and permit callers to retry. */
  constructor() {
    super(
      503,
      "API_DOCUMENTATION_UNAVAILABLE",
      "API documentation is not ready yet. Try again shortly.",
    );
  }
}
