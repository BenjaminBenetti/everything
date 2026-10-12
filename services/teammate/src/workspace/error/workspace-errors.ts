import { ApplicationError } from "@everything/errors";

/** Refuse inaccessible files without leaking container paths. */
export class FileAccessError extends ApplicationError {
  /** Describe an invalid workspace operation. */
  constructor(
    message = "The file is unavailable. Use a regular file inside your workspace.",
  ) {
    super(400, "FILE_ACCESS_FAILED", message);
  }
}

/** Reject overlapping shell runs in the same process namespace. */
export class WorkspaceBusyError extends ApplicationError {
  /** Let the caller retry after the active command settles. */
  constructor() {
    super(
      409,
      "WORKSPACE_BUSY",
      "A command is already running in this teammate's workspace.",
    );
  }
}

/** Authenticate the internal control API independently of cluster networking. */
export class WorkspaceUnauthorizedError extends ApplicationError {
  /** Expose no credential information. */
  constructor() {
    super(
      401,
      "WORKSPACE_UNAUTHORIZED",
      "This workspace request is not authorized.",
    );
  }
}
