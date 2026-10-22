import type { BinaryTransport } from "../interface/binary-transport.js";
import type { JsonTransport } from "../interface/json-transport.js";
import { HttpRequestError } from "../model/http-request-error.js";

/** A server error code: an uppercase identifier, never free text that could carry data. */
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Read only the stable error code from a failure body; anything else in it is discarded. */
async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === "string" && errorCodePattern.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

/** Apply same-origin cookie authentication and safe error messages at one boundary. */
export function createAuthenticatedTransport(
  fetcher: typeof fetch = fetch,
): JsonTransport & BinaryTransport {
  /** Restrict credentials to the application's API and accept JSON or a successful empty response. */
  async function send<T>(
    path: string,
    options: RequestInit,
    contentType: string | undefined,
  ): Promise<T> {
    if (!path.startsWith("/v1/") || path.includes("..") || path.includes("\\"))
      throw new Error("Invalid API path");
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (contentType) headers.set("Content-Type", contentType);
    const response = await fetcher(path, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) {
      const code = await errorCode(response);
      if (response.status === 401)
        throw new HttpRequestError(
          401,
          "Your session has expired. Sign out and sign in again.",
          code,
        );
      if (response.status === 404)
        throw new HttpRequestError(
          404,
          "This item is no longer available. Refresh and try again.",
          code,
        );
      if (response.status === 429)
        throw new HttpRequestError(
          429,
          "Too many requests. Please wait a moment and try again.",
          code,
        );
      throw new HttpRequestError(
        response.status,
        "We couldn’t complete that request. Please try again.",
        code,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    /** Send JSON, or no body. */
    request<T>(path: string, options: RequestInit = {}): Promise<T> {
      return send<T>(
        path,
        options,
        options.body ? "application/json" : undefined,
      );
    },
    /** Send raw bytes with their own content type. */
    upload<T>(
      path: string,
      body: Blob,
      contentType: string,
      signal?: AbortSignal,
    ): Promise<T> {
      return send<T>(
        path,
        { method: "POST", body, ...(signal ? { signal } : {}) },
        contentType,
      );
    },
  };
}
