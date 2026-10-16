import { createRemoteJWKSet } from "jose";
import type { TokenVerifier } from "../interface/token-verifier.js";
import {
  AccessTokenVerifier,
  type AccessTokenIdentityResolver,
} from "../service/access-token-verifier.js";

/** Trust configuration supplied by each service consuming Keycloak access tokens. */
export interface KeycloakTokenConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  /** Optional service policy for resolving a verified caller's effective identity. */
  readonly resolveIdentity?: AccessTokenIdentityResolver;
}

/** Create a verifier with cached signing keys and the service's explicit trust boundary. */
export function createKeycloakTokenVerifier(
  configuration: KeycloakTokenConfiguration,
): TokenVerifier {
  httpUrl(configuration.issuer, "issuer");
  const jwksUrl = httpUrl(configuration.jwksUrl, "JWKS URL");
  if (!configuration.audience.trim())
    throw new Error("An access-token audience is required");
  return new AccessTokenVerifier(
    createRemoteJWKSet(jwksUrl),
    configuration.issuer,
    configuration.audience,
    configuration.resolveIdentity,
  );
}

/** Parse an authentication endpoint; transport security is provided by the cluster, not required here. */
function httpUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`The ${label} must be an HTTP or HTTPS URL`);
  return url;
}
