import { ApplicationError } from "@everything/errors";

/** Fleet is still starting, or its daemon did not answer. */
export class WorkersUnavailableError extends ApplicationError {
  /** Ask the user to retry once Fleet is up. */
  constructor() {
    super(
      503,
      "WORKERS_UNAVAILABLE",
      "Workers aren’t available right now. Try again in a moment.",
    );
  }
}
