import { ApplicationError } from "@everything/errors";

/** New agent work is refused while the process drains for shutdown. */
export class ServiceShuttingDownError extends ApplicationError {
  /** Report that the service is no longer accepting work. */
  constructor() {
    super(503, "SHUTTING_DOWN", "The service is shutting down.");
  }
}

/** A message needs words or at least one attached file. */
export class EmptyMessageError extends ApplicationError {
  /** Ask for something to send. */
  constructor() {
    super(400, "MESSAGE_EMPTY", "Write a message or attach a file to send.");
  }
}
