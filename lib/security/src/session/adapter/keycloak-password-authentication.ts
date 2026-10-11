import { decodeJwt } from "jose";
import type { TokenVerifier } from "../../auth/interface/token-verifier.js";
import type { SessionCredentials } from "../interface/browser-session.js";
import {
  AuthenticationFailure,
  type PasswordAuthentication,
  type SessionGrant,
} from "../interface/password-authentication.js";
export { AuthenticationFailure } from "../interface/password-authentication.js";
export type {
  PasswordAuthentication,
  SessionGrant,
} from "../interface/password-authentication.js";

/** Server-only configuration; endpoints never come from browser input. */
export interface PasswordAuthenticationConfig {
  readonly protocolUrl: string;
  readonly publicOrigin: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Adapt Keycloak Direct Access Grants; no provider tokens or errors reach the browser. */
export class KeycloakPasswordAuthentication implements PasswordAuthentication {
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the dedicated confidential client and the existing issuer/audience verifier. */
  constructor(
    private readonly config: PasswordAuthenticationConfig,
    private readonly verifier: TokenVerifier,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Authenticate a password without retaining it. */
  authenticate(credentials: SessionCredentials): Promise<SessionGrant> {
    return this.exchange({
      grant_type: "password",
      username: credentials.username,
      password: credentials.password,
      scope: "openid profile",
    });
  }

  /** Exchange the latest refresh token; callers serialize rotation per session. */
  refresh(refreshToken: string): Promise<SessionGrant> {
    return this.exchange({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }

  /** Invalidate the provider session using its refresh token. */
  async revoke(refreshToken: string): Promise<void> {
    const response = await this.request("logout", {
      refresh_token: refreshToken,
    });
    if (!response.ok) throw new AuthenticationFailure("unavailable");
  }

  // ===========================================
  // Provider boundary
  // ===========================================

  /** Verify every issued access token before trusting identity or display claims. */
  private async exchange(
    parameters: Record<string, string>,
  ): Promise<SessionGrant> {
    const response = await this.request("token", parameters);
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new AuthenticationFailure("unavailable");
    }
    if (!body || typeof body !== "object")
      throw new AuthenticationFailure("unavailable");
    if (!response.ok)
      throw new AuthenticationFailure(
        response.status === 400 && body.error === "invalid_grant"
          ? "rejected"
          : "unavailable",
      );
    if (
      typeof body.access_token !== "string" ||
      typeof body.refresh_token !== "string" ||
      typeof body.expires_in !== "number" ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0 ||
      typeof body.refresh_expires_in !== "number" ||
      !Number.isFinite(body.refresh_expires_in) ||
      body.refresh_expires_in <= 0
    )
      throw new AuthenticationFailure("unavailable");
    try {
      const identity = await this.verifier.verify(body.access_token);
      const claims = decodeJwt(body.access_token);
      const now = Date.now();
      return {
        profile: {
          subject: identity.subject,
          displayName:
            typeof claims.preferred_username === "string"
              ? claims.preferred_username
              : "Your workspace",
        },
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        accessExpiresAt: Math.min(
          now + body.expires_in * 1000,
          (claims.exp ?? 0) * 1000,
        ),
        refreshExpiresAt: now + body.refresh_expires_in * 1000,
      };
    } catch {
      throw new AuthenticationFailure("unavailable");
    }
  }

  /** Bound network work and prevent redirects or upstream details from escaping. */
  private async request(
    endpoint: string,
    parameters: Record<string, string>,
  ): Promise<Response> {
    try {
      const origin = new URL(this.config.publicOrigin);
      return await this.fetcher(this.config.protocolUrl + "/" + endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "X-Forwarded-Proto": origin.protocol.slice(0, -1),
          "X-Forwarded-Host": origin.host,
          "X-Forwarded-Port":
            origin.port || (origin.protocol === "https:" ? "443" : "80"),
        },
        body: new URLSearchParams({
          ...parameters,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      });
    } catch {
      throw new AuthenticationFailure("unavailable");
    }
  }
}
