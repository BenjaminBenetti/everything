/** An expected failure with a stable public error code and HTTP status. */
export class ApplicationError extends Error {
  /** Create an error whose message is safe to return to the caller. */
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
