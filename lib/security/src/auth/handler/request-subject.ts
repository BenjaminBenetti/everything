import type { FastifyRequest } from "fastify";

/** Read the subject verified by the protected scope's authentication hook. */
export function subject(request: FastifyRequest): string {
  if (!request.identity)
    throw new Error("Protected route is missing its authentication hook");
  return request.identity.subject;
}
