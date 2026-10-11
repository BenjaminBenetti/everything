export { sessionInputLimits } from "../model/session-input.js";
import type {
  BrowserSession,
  SessionProfile,
} from "../interface/browser-session.js";
export type {
  BrowserSession,
  SessionProfile,
  SessionCredentials,
} from "../interface/browser-session.js";

/** Exchange only same-origin credentials and profiles; cookies are managed by the browser. */
export function createBrowserSession(
  fetcher: typeof fetch = fetch,
): BrowserSession {
  let initialization: Promise<SessionProfile | null> | undefined;
  /** Restrict authentication traffic to fixed application endpoints. */
  async function request(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetcher(path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      throw new Error("We couldn’t connect. Please try again.");
    }
    if (!response.ok) {
      if (response.status === 401)
        throw new Error(
          "The username or password is incorrect. Please try again.",
        );
      if (response.status === 429)
        throw new Error(
          "Too many sign-in attempts. Please wait a moment and try again.",
        );
      throw new Error("Sign-in is temporarily unavailable. Please try again.");
    }
    return response;
  }
  return {
    /** Restore once, including React development effect replays. */
    initialize() {
      initialization ??= request("/v1/session").then(
        async (response) =>
          ((await response.json()) as { profile: SessionProfile | null })
            .profile,
      );
      return initialization;
    },
    /** Submit a password once and retain only the returned display profile. */
    async signIn(credentials) {
      const response = await request("/v1/session", {
        method: "POST",
        body: JSON.stringify(credentials),
      });
      const { profile } = (await response.json()) as {
        profile: SessionProfile;
      };
      initialization = Promise.resolve(profile);
      return profile;
    },
    /** Clear the local initialization result only after the server confirms revocation. */
    async signOut() {
      await request("/v1/session/logout", { method: "POST", body: "{}" });
      initialization = Promise.resolve(null);
    },
  };
}
