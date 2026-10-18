/** A failed API request: a safe message and the HTTP status, never the response body. */
export class HttpRequestError extends Error {
  /** Keep the status so a domain adapter can describe the failure in its own terms. */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}
