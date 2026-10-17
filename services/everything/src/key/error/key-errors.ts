import { ApplicationError } from "@everything/errors";

/** A shared key no longer exists in this installation. */
export class KeyNotFoundError extends ApplicationError {
  /** Return a consistent missing-key response for lookup and rename. */
  constructor() {
    super(404, "KEY_NOT_FOUND", "Key not found.");
  }
}

/** Reject unsupported formats and malformed material without echoing secrets. */
export class InvalidKeyError extends ApplicationError {
  /** Return a safe instruction with no parser or key details. */
  constructor() {
    super(
      400,
      "INVALID_KEY",
      "Choose a supported key type and upload a key in that format.",
    );
  }
}
