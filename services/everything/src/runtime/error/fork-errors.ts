import { ApplicationError } from "@everything/errors";

/** Private session addresses must belong to the current teammate and remain usable. */
export class ForkUnavailableError extends ApplicationError {
  /** Give the model a safe recovery path without exposing another teammate's sessions. */
  constructor() {
    super(
      409,
      "FORK_UNAVAILABLE",
      "This fork is unavailable. List this teammate’s forks and use an available address.",
    );
  }
}

/** Keep one teammate's background work bounded. */
export class ForkLimitError extends ApplicationError {
  /** Ask the teammate to finish existing work before creating additional concurrent work. */
  constructor() {
    super(
      409,
      "FORK_LIMIT",
      "This teammate already has eight forks starting or working. Wait for one to finish or stop a fork first.",
    );
  }
}
