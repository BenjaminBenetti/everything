/** Display-only profile; authorization remains with the API's verified identity. */
export interface SessionProfile {
  readonly subject: string;
  readonly displayName: string;
}

/** Transient form input; never retained in browser storage or the server session. */
export interface SessionCredentials {
  readonly username: string;
  readonly password: string;
}

/** Browser authentication boundary; provider tokens stay on the server. */
export interface BrowserSession {
  /** Restore the application's cookie session. */
  initialize(): Promise<SessionProfile | null>;
  /** Authenticate without navigating away from the application. */
  signIn(credentials: SessionCredentials): Promise<SessionProfile>;
  /** Revoke the server session and clear its cookie. */
  signOut(): Promise<void>;
}
