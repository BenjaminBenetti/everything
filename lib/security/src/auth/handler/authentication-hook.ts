import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Identity } from "../model/identity.js";
import type { TokenVerifier } from "../interface/token-verifier.js";

export { subject } from "./request-subject.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Verified caller; set only inside scopes protected by requireAuthentication. */
    identity: Identity | null;
  }
}

/** A single bearer credential; anything else is rejected without calling the verifier. */
const bearerCredential = /^Bearer ([^\s]+)$/i;

/** Uniform rejection so callers cannot distinguish missing, malformed, and invalid tokens. */
const unauthenticated = {
  code: "UNAUTHENTICATED",
  message: "A valid access token is required.",
} as const;

/** Require a verified bearer token for every route registered in this Fastify scope. */
export function requireAuthentication(
  scope: FastifyInstance,
  verifier: TokenVerifier,
): void {
  scope.decorateRequest("identity", null);
  scope.addHook("onRequest", authenticationHook(verifier));
}

/** Build a fail-closed hook that authenticates before protected content is parsed or handled. */
function authenticationHook(verifier: TokenVerifier) {
  /** Attach the verified identity, or reply 401 without exposing why verification failed. */
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = bearerCredential.exec(request.headers.authorization ?? "");
    try {
      if (!token?.[1]) throw new Error("Missing bearer token");
      request.identity = await verifier.verify(token[1]);
    } catch {
      reply.header("WWW-Authenticate", 'Bearer realm="everything"');
      await reply.code(401).send(unauthenticated);
    }
  };
}
