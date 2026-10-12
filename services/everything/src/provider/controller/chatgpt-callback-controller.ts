import type { FastifyInstance } from "fastify";
import { anonymousRateLimit } from "../../http/config/rate-limit.js";

/** Return authorization codes to the initiating browser; this public route never exchanges tokens. */
export async function chatGptCallbackController(
  app: FastifyInstance,
  publicOrigin: string,
  redirectUri: string,
): Promise<void> {
  app.get(
    "/v1/providers/chatgpt/callback",
    { logLevel: "silent", config: { rateLimit: anonymousRateLimit } },
    async (request, reply) => {
      const callback = new URL(request.url, redirectUri);
      reply.header("Cache-Control", "no-store");
      reply.header("Referrer-Policy", "no-referrer");
      // Fragments stay out of server access logs; the UI validates browser state before posting the code.
      return reply.redirect(
        `${publicOrigin}/#chatgpt=${encodeURIComponent(callback.href)}`,
      );
    },
  );
}
