import type { FastifyRequest } from "fastify";
import type { CredentialSource } from "../model/credential-source.js";

/** Read the subject verified by the protected scope's authentication hook. */
export function subject(request: FastifyRequest): string {
  if (!request.identity)
    throw new Error("Protected route is missing its authentication hook");
  return request.identity.subject;
}

/** Read how the protected scope's authentication hook received the verified token. */
export function credentialSource(request: FastifyRequest): CredentialSource {
  if (!request.identity || !request.credentialSource)
    throw new Error("Protected route is missing its authentication hook");
  return request.credentialSource;
}
