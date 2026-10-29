import { ApplicationError } from "@everything/errors";

/** Identical response for unknown users, rejected passwords, and blocked accounts. */
export class SignInRejected extends ApplicationError {
  /** Expose no provider diagnostics or account existence. */
  constructor() {
    super(401, "SIGN_IN_REJECTED", "The username or password is incorrect.");
  }
}
/** Temporary provider failure, distinct from a rejected password. */
export class SignInUnavailable extends ApplicationError {
  /** Allow callers to retry without receiving internal details. */
  constructor() {
    super(503, "SIGN_IN_UNAVAILABLE", "Sign-in is temporarily unavailable.");
  }
}
/** A cookie-bearing mutation must originate on the configured application origin. */
export class SessionOriginRejected extends ApplicationError {
  /** Fail closed for missing, foreign, and malformed origins. */
  constructor() {
    super(
      403,
      "SESSION_ORIGIN_REJECTED",
      "This request must originate from the application.",
    );
  }
}
/** Some changes are made only by a person in the application, never by an app or teammate token. */
export class SignedInUserRequired extends ApplicationError {
  /** Point to the screen where the person makes the change. */
  constructor() {
    super(
      403,
      "SIGNED_IN_USER_REQUIRED",
      "Only you can make this change, from Everything in your browser. Apps and teammates can't make it for you.",
    );
  }
}
