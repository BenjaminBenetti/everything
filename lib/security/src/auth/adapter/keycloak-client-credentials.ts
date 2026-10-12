import type { AccessTokenSource } from "../interface/access-token-source.js";
import { keycloakTokenRequest } from "./keycloak-forwarding.js";

export type { AccessTokenSource } from "../interface/access-token-source.js";

/** Server-only configuration of a confidential client with a service account. */
export interface ClientCredentialsConfig {
  /** Keycloak's OpenID Connect protocol URL, ending in `/protocol/openid-connect`. */
  readonly protocolUrl: string;
  /** Public origin whose issuer the tokens must carry. */
  readonly publicOrigin: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Tokens are renewed this long before they expire, so callers never send an expiring token. */
const renewalMarginMs = 30_000;

/** A token and the time it stops being reused. */
interface CachedToken {
  readonly value: string;
  readonly renewAt: number;
}

/** Obtain service-account tokens with the client credentials grant, reusing each until near expiry. */
export class KeycloakClientCredentials implements AccessTokenSource {
  // ===========================================
  // State
  // ===========================================

  private cached: CachedToken | undefined;
  private pending: Promise<string> | undefined;

  // ===========================================
  // Construction
  // ===========================================

  /** Bind the client's credentials; the clock and fetcher are replaceable for tests. */
  constructor(
    private readonly config: ClientCredentialsConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Reuse the cached token, or share one request among concurrent callers. */
  async token(): Promise<string> {
    if (this.cached && this.cached.renewAt > this.now())
      return this.cached.value;
    this.pending ??= this.request().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  // ===========================================
  // Provider boundary
  // ===========================================

  /** Request a token, reporting only the status of a rejected request. */
  private async request(): Promise<string> {
    const response = await this.fetcher(
      this.config.protocolUrl + "/token",
      keycloakTokenRequest(this.config.publicOrigin, {
        grant_type: "client_credentials",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
    );
    if (!response.ok)
      throw new Error(
        `The identity provider refused the client credentials (${response.status})`,
      );
    const body = (await response.json()) as Record<string, unknown>;
    if (
      typeof body.access_token !== "string" ||
      typeof body.expires_in !== "number" ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0
    )
      throw new Error("The identity provider returned an invalid token");
    this.cached = {
      value: body.access_token,
      renewAt: this.now() + body.expires_in * 1000 - renewalMarginMs,
    };
    return body.access_token;
  }
}
