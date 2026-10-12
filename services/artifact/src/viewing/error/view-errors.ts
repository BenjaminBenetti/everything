import { ApplicationError } from "@everything/errors";

/** A view request named a path that is not inside the artifact. */
export class InvalidViewPathError extends ApplicationError {
  /** Ask for a path inside the artifact. */
  constructor() {
    super(
      400,
      "INVALID_VIEW_PATH",
      "Open a path inside the artifact, starting with a single /.",
    );
  }
}
