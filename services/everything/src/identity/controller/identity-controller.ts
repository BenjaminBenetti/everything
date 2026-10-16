import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import { identityResponse } from "../schema/identity-response.js";

/** Register the endpoint reporting the caller's verified subject. */
export async function identityController(app: FastifyInstance): Promise<void> {
  app.get(
    "/me",
    {
      schema: {
        summary: "Read the authenticated identity",
        description:
          "App client credentials resolve to the app owner's subject.",
        response: { 200: identityResponse },
      },
    },
    async (request) => ({ subject: subject(request) }),
  );
}
