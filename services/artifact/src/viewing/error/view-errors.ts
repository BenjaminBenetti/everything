import { ApplicationError } from "@everything/errors";

/** A view request named a path that is not inside the app. */
export class InvalidViewPathError extends ApplicationError {
  /** Ask for a path inside the app. */
  constructor() {
    super(
      400,
      "INVALID_VIEW_PATH",
      "Open a path inside the app, starting with a single /.",
    );
  }
}
