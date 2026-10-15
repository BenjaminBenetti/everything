import { ApplicationError } from "@everything/errors";

/** The app service answered with a failure; its message is written for teammates and users. */
export class ArtifactRequestFailure extends Error {
  /** Keep the app service's status and code for callers that map them. */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactRequestFailure";
  }
}

/** The requested app does not exist or is not the caller's. */
export class ArtifactNotFoundError extends ApplicationError {
  /** Report the app as absent. */
  constructor() {
    super(404, "ARTIFACT_NOT_FOUND", "App not found.");
  }
}

/** The app service could not be reached or failed. */
export class ArtifactServiceUnavailableError extends ApplicationError {
  /** Ask the user to try again later. */
  constructor() {
    super(
      503,
      "ARTIFACTS_UNAVAILABLE",
      "Apps are unavailable right now. Try again in a moment.",
    );
  }
}

/** The app's current state does not allow the requested manual action. */
export class AppActionConflictError extends ApplicationError {
  /** Ask the user to refresh before retrying a lifecycle action. */
  constructor() {
    super(
      409,
      "APP_ACTION_CONFLICT",
      "The app can’t do that in its current state. Refresh its status and try again.",
    );
  }
}
