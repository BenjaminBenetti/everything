import { jwtVerify, type JWTVerifyGetKey } from "jose";
import type { TokenVerifier } from "../interface/token-verifier.js";
import type { Identity } from "../model/identity.js";

/** Validates Keycloak access tokens against a trusted issuer, audience, and signing keys. */
export class AccessTokenVerifier implements TokenVerifier {
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the verifier to the configured trust boundary. */
  constructor(
    private readonly keys: JWTVerifyGetKey,
    private readonly issuer: string,
    private readonly audience: string,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Reject expired, incorrectly signed, wrong-audience, and non-access tokens. */
  async verify(token: string): Promise<Identity> {
    const { payload } = await jwtVerify(token, this.keys, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat", "iss", "aud"],
      clockTolerance: 5,
    });
    if (!payload.sub || payload.typ !== "Bearer")
      throw new Error("Expected a Keycloak access token");
    return { subject: payload.sub };
  }
}
