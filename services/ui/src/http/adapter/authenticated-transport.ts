import type { JsonTransport } from "../interface/json-transport.js";

/** Apply same-origin cookie authentication and safe error messages at one boundary. */
export function createAuthenticatedTransport(
  fetcher: typeof fetch = fetch,
): JsonTransport {
  return {
    /** Restrict credentials to the application's API and accept JSON or a successful empty response. */
    async request<T>(path: string, options: RequestInit = {}): Promise<T> {
      if (
        !path.startsWith("/v1/") ||
        path.includes("..") ||
        path.includes("\\")
      )
        throw new Error("Invalid API path");
      const headers = new Headers(options.headers);
      headers.set("Accept", "application/json");
      if (options.body) headers.set("Content-Type", "application/json");
      const response = await fetcher(path, {
        ...options,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) {
        if (response.status === 401)
          throw new Error(
            "Your session has expired. Sign out and sign in again.",
          );
        if (response.status === 404)
          throw new Error(
            "This item is no longer available. Refresh and try again.",
          );
        if (response.status === 429)
          throw new Error(
            "Too many requests. Please wait a moment and try again.",
          );
        throw new Error("We couldn’t complete that request. Please try again.");
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    },
  };
}
