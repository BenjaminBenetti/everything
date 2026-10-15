import type { FastifyRequest } from "fastify";
import type { ArtifactAuthor } from "@everything/artifact-contracts";
import { MissingActorError } from "../../artifact/error/artifact-errors.js";

/** Headers naming the teammate or user on whose behalf Everything calls; the name is URI-encoded. */
export const actorHeaders = {
  id: "x-everything-actor-id",
  name: "x-everything-actor-name",
} as const;

/** Longest accepted actor ID or name. */
const actorFieldLength = 200;

/** Read the acting teammate or user from trusted headers set by Everything. */
export function requestActor(request: FastifyRequest): ArtifactAuthor {
  const id = request.headers[actorHeaders.id];
  const encodedName = request.headers[actorHeaders.name];
  if (typeof id !== "string" || typeof encodedName !== "string")
    throw new MissingActorError();
  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    throw new MissingActorError();
  }
  if (
    !id.trim() ||
    !name.trim() ||
    id.length > actorFieldLength ||
    name.length > actorFieldLength
  )
    throw new MissingActorError();
  return { id, name };
}
