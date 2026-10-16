import { ApplicationError } from "@everything/errors";

/** Unknown and inaccessible background sessions have the same public behavior. */
export class SubagentNotFoundError extends ApplicationError {
  /** Do not reveal another teammate's session addresses or filesystem paths. */
  constructor() {
    super(404, "SUBAGENT_NOT_FOUND", "This background teammate wasn't found.");
  }
}

/** A configured runtime must support background work before accepting requests. */
export class SubagentsUnavailableError extends ApplicationError {
  /** Keep runtime configuration and provider details private. */
  constructor() {
    super(
      503,
      "SUBAGENTS_UNAVAILABLE",
      "Background work is unavailable for this teammate.",
    );
  }
}
