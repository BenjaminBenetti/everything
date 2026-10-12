import { ApplicationError } from "@everything/errors";

/** A file list breaks a path rule or a size limit; the message names the problem. */
export class InvalidFilesError extends ApplicationError {
  /** Describe the first problem found. */
  constructor(detail: string) {
    super(400, "INVALID_FILES", detail);
  }
}

/** Some listed files were never uploaded. */
export class MissingContentError extends ApplicationError {
  /** Report how many files are missing. */
  constructor(count: number) {
    super(
      409,
      "CONTENT_MISSING",
      `${count} ${count === 1 ? "file has" : "files have"} not been uploaded yet. Upload them and try again.`,
    );
  }
}

/** Uploaded bytes do not hash to the address they were uploaded to. */
export class ContentMismatchError extends ApplicationError {
  /** Reject the upload. */
  constructor() {
    super(
      400,
      "CONTENT_MISMATCH",
      "The uploaded content does not match its SHA-256 hash.",
    );
  }
}

/** An upload exceeded the per-file limit. */
export class ContentTooLargeError extends ApplicationError {
  /** Report the limit in MiB. */
  constructor(limit: number) {
    super(
      413,
      "CONTENT_TOO_LARGE",
      `Files can be at most ${Math.floor(limit / (1024 * 1024))} MiB.`,
    );
  }
}

/** No content is stored under the requested hash. */
export class ContentNotFoundError extends ApplicationError {
  /** Report the content as absent. */
  constructor() {
    super(404, "CONTENT_NOT_FOUND", "Content not found.");
  }
}
