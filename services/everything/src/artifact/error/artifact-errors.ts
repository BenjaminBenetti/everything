import { ApplicationError } from "@everything/errors";

/** The artifact service answered with a failure; its message is written for teammates and users. */
export class ArtifactRequestFailure extends Error {
  /** Keep the artifact service's status and code for callers that map them. */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactRequestFailure";
  }
}

/** The requested artifact does not exist or is not the caller's. */
export class ArtifactNotFoundError extends ApplicationError {
  /** Report the artifact as absent. */
  constructor() {
    super(404, "ARTIFACT_NOT_FOUND", "Artifact not found.");
  }
}

/** The artifact service could not be reached or failed. */
export class ArtifactServiceUnavailableError extends ApplicationError {
  /** Ask the user to try again later. */
  constructor() {
    super(
      503,
      "ARTIFACTS_UNAVAILABLE",
      "Artifacts are unavailable right now. Try again in a moment.",
    );
  }
}
