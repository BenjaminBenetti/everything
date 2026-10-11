import type { SessionProfile, SessionCredentials } from "./browser-session.js";

/** Verified credentials held only by a server-side session. */
export interface SessionGrant {
  readonly profile: SessionProfile;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
}

/** Small identity-provider boundary for password sessions. */
export interface PasswordAuthentication {
  /** Exchange credentials for a verified session. */
  authenticate(credentials: SessionCredentials): Promise<SessionGrant>;
  /** Rotate tokens without collecting the password again. */
  refresh(refreshToken: string): Promise<SessionGrant>;
  /** Revoke the identity-provider session. */
  revoke(refreshToken: string): Promise<void>;
}

/** Classify provider failures without exposing upstream responses or credentials. */
export class AuthenticationFailure extends Error {
  /** Record only the safe classification used by application policy. */
  constructor(readonly reason: "rejected" | "unavailable") {
    super("Authentication " + reason);
  }
}
