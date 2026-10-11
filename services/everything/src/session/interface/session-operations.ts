import type {
  SessionCredentials,
  SessionProfile,
} from "@everything/security/browser";

/** Cookie transport depends only on these application operations. */
export interface SessionOperations {
  /** Create a new capability and revoke the prior browser session, if present. */
  signIn(
    credentials: SessionCredentials,
    previous?: string,
  ): Promise<{ handle: string; profile: SessionProfile }>;
  /** Resolve and refresh credentials behind a valid browser capability. */
  resolve(
    handle?: string,
  ): Promise<{ accessToken: string; profile: SessionProfile } | undefined>;
  /** Permanently invalidate a browser capability. */
  signOut(handle?: string): Promise<void>;
}
