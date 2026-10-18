import { ApplicationError } from "@everything/errors";

/** Unknown, expired, and forgotten monitors have the same public behavior. */
export class MonitorNotFoundError extends ApplicationError {
  /** Report that the pod no longer tracks the command, for example after a restart. */
  constructor() {
    super(404, "MONITOR_NOT_FOUND", "This monitor wasn't found.");
  }
}

/** Keep one teammate's background commands bounded. */
export class MonitorLimitError extends ApplicationError {
  /** Ask the teammate to wait for or stop an existing monitor first. */
  constructor(limit: number) {
    super(
      409,
      "MONITOR_LIMIT",
      `This teammate already has ${limit} monitors running. Wait for one to finish or stop one first.`,
    );
  }
}

/** New monitors are refused while the pod drains for replacement. */
export class MonitorsClosedError extends ApplicationError {
  /** Report that the workspace is stopping. */
  constructor() {
    super(
      503,
      "MONITORS_CLOSED",
      "This teammate's workspace is restarting. Try again shortly.",
    );
  }
}
