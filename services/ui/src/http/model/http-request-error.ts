/**
 * A failed API request: a safe message, the HTTP status, and the server's stable error code when it
 * sent one. The server's own message and the rest of the body are never kept.
 */
export class HttpRequestError extends Error {
  /** Keep the status and code so a domain adapter can describe the failure in its own terms. */
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}
