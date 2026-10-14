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
