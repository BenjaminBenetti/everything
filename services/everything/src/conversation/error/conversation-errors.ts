import { ApplicationError } from "@everything/errors";

/** New agent work is refused while the process drains for shutdown. */
export class ServiceShuttingDownError extends ApplicationError {
  /** Report that the service is no longer accepting work. */
  constructor() {
    super(503, "SHUTTING_DOWN", "The service is shutting down.");
  }
}
