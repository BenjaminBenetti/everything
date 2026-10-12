import type { OidcIdentity } from "../model/oidc-identity.js";

/** Identity validation supports per-registration audiences and per-attempt nonces. */
export interface OidcIdentityVerifier {
  /** Verify the issuer, signature, audience, expiry, and optional authorization nonce. */
  verify(
    token: string,
    audience: string,
    nonce?: string,
  ): Promise<OidcIdentity>;
}
