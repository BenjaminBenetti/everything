import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CredentialSource } from "../model/credential-source.js";
import type { Identity } from "../model/identity.js";
import type { TokenVerifier } from "../interface/token-verifier.js";

export type { CredentialSource } from "../model/credential-source.js";
export { credentialSource, subject } from "./request-subject.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Verified caller; set only inside scopes protected by requireAuthentication. */
    identity: Identity | null;
    /** How the verified caller presented its token; set together with identity. */
    credentialSource: CredentialSource | null;
  }
}

/** A single bearer credential; anything else is rejected without calling the verifier. */
const bearerCredential = /^Bearer ([^\s]+)$/i;

/** Uniform rejection so callers cannot distinguish missing, malformed, and invalid tokens. */
const unauthenticated = {
  code: "UNAUTHENTICATED",
  message: "A valid access token is required.",
} as const;

/** Optional server-owned session resolver; explicit Authorization always takes precedence. */
export type SessionTokenResolver = (
  request: FastifyRequest,
) => Promise<string | undefined>;

/** Require a verified access token from a bearer header or a server-owned session. */
export function requireAuthentication(
  scope: FastifyInstance,
  verifier: TokenVerifier,
  sessionToken?: SessionTokenResolver,
): void {
  scope.decorateRequest("identity", null);
  scope.decorateRequest("credentialSource", null);
  scope.addHook("onRequest", authenticationHook(verifier, sessionToken));
}

/** Build a fail-closed hook that authenticates before protected content is parsed or handled. */
function authenticationHook(
  verifier: TokenVerifier,
  sessionToken?: SessionTokenResolver,
) {
  /** Attach the verified identity and its source, or reply 401 without exposing why verification failed. */
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const header = request.headers.authorization;
      const token =
        header === undefined
          ? await sessionToken?.(request)
          : bearerCredential.exec(header)?.[1];
      if (!token) throw new Error("Missing access token");
      request.identity = await verifier.verify(token);
      request.credentialSource = header === undefined ? "session" : "bearer";
    } catch {
      reply.header("WWW-Authenticate", 'Bearer realm="everything"');
      await reply.code(401).send(unauthenticated);
    }
  };
}
