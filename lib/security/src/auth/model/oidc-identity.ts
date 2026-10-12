/** Verified account identity from an OIDC ID token. */
export interface OidcIdentity {
  readonly subject: string;
  readonly email?: string;
}
