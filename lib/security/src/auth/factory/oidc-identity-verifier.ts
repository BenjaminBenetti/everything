import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OidcIdentityVerifier } from "../interface/oidc-identity-verifier.js";

export type { OidcIdentityVerifier } from "../interface/oidc-identity-verifier.js";
export type { OidcIdentity } from "../model/oidc-identity.js";

/** Configure a trusted issuer at the composition root; token claims never select a key server. */
export function createOidcIdentityVerifier(
  issuer: string,
  jwksUrl: string,
): OidcIdentityVerifier {
  const keys = createRemoteJWKSet(new URL(jwksUrl), {
    timeoutDuration: 10_000,
  });
  return {
    /** Reject a token for a different registration or sign-in attempt. */
    async verify(token, audience, nonce) {
      const { payload } = await jwtVerify(token, keys, {
        issuer,
        audience,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat"],
      });
      if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce))
        throw new Error("OIDC identity could not be verified");
      return {
        subject: payload.sub,
        ...(typeof payload.email === "string" ? { email: payload.email } : {}),
      };
    },
  };
}
