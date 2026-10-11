import { ApplicationError } from "@everything/errors";

/** The agent is missing or owned by someone else; both look identical so ownership is never revealed. */
export class AgentNotFoundError extends ApplicationError {
  /** Report the agent as absent. */
  constructor() {
    super(404, "AGENT_NOT_FOUND", "Agent not found.");
  }
}
