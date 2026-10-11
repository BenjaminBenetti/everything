import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";

/** Register the endpoint reporting the caller's verified subject. */
export async function identityController(app: FastifyInstance): Promise<void> {
  app.get("/me", async (request) => ({ subject: subject(request) }));
}
