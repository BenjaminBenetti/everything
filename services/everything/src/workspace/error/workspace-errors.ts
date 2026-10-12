import { ApplicationError } from "@everything/errors";

/** Tools never fall back to running commands inside Everything. */
export class WorkspaceUnavailableError extends ApplicationError {
  /** Let the teammate explain that its pod is starting or being repaired. */
  constructor() {
    super(
      503,
      "WORKSPACE_UNAVAILABLE",
      "This teammate's workspace is starting or restarting. Try again shortly.",
    );
  }
}

/** Preserve safe workspace API failures without exposing transport internals. */
export class WorkspaceOperationError extends ApplicationError {
  /** Return the tools service's safe explanation. */
  constructor(message: string) {
    super(400, "WORKSPACE_OPERATION_FAILED", message);
  }
}
