import { ApplicationError } from "@everything/errors";

/** Unknown, finished, and other teammates' monitors have the same public behavior. */
export class MonitorNotFoundError extends ApplicationError {
  /** Point the teammate to its own running monitors. */
  constructor() {
    super(
      404,
      "MONITOR_NOT_FOUND",
      "This monitor isn't running. List your monitors to find a running one.",
    );
  }
}

/** A monitor started while its teammate's work was being stopped is stopped too. */
export class MonitorStoppedError extends ApplicationError {
  /** Explain that the command did not keep running. */
  constructor() {
    super(
      409,
      "MONITOR_STOPPED",
      "This teammate's work was stopped, so the monitor was stopped too.",
    );
  }
}

/** New monitors are refused while Everything shuts down. */
export class MonitorsUnavailableError extends ApplicationError {
  /** Report that results could not be delivered if the command started now. */
  constructor() {
    super(
      503,
      "MONITORS_UNAVAILABLE",
      "Monitors are unavailable while Everything restarts. Try again shortly.",
    );
  }
}
