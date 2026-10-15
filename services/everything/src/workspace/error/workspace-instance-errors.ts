import { ApplicationError } from "@everything/errors";

/** The workspace runtime cannot currently answer a request. */
export class WorkspaceInstancesUnavailableError extends ApplicationError {
  /** Keep runtime details private while allowing the caller to retry. */
  constructor() {
    super(
      503,
      "WORKSPACE_INSTANCES_UNAVAILABLE",
      "Workspaces aren’t available right now. Try again in a moment.",
    );
  }
}

/** A requested instance no longer exists. */
export class WorkspaceInstanceNotFoundError extends ApplicationError {
  /** Treat every missing instance consistently. */
  constructor() {
    super(
      404,
      "WORKSPACE_INSTANCE_NOT_FOUND",
      "This workspace is no longer available.",
    );
  }
}

/** An action is incompatible with the instance's current lifecycle state. */
export class WorkspaceInstanceConflictError extends ApplicationError {
  /** Ask the caller to refresh instead of performing an unsafe transition. */
  constructor() {
    super(
      409,
      "WORKSPACE_INSTANCE_CONFLICT",
      "This workspace’s status has changed. Refresh and try again. Only stopped workspaces can be deleted.",
    );
  }
}
