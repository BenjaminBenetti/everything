import type { FastifyInstance } from "fastify";
import { anonymousRateLimit } from "../../http/config/rate-limit.js";
import type { SessionOperations } from "../interface/session-operations.js";
import { SessionCookie } from "../handler/session-cookie.js";
import { signInBody, type SignInBody } from "../schema/session-request.js";

/** Keep credential exchange outside bearer-protected routes; never return provider tokens. */
export async function sessionController(
  app: FastifyInstance,
  sessions: SessionOperations,
  cookie: SessionCookie,
): Promise<void> {
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  app.get(
    "/session",
    { config: { rateLimit: anonymousRateLimit } },
    async (request, reply) => {
      const session = await sessions.resolve(cookie.read(request));
      if (!session) cookie.clear(reply);
      return { profile: session?.profile ?? null };
    },
  );
  app.post<{ Body: SignInBody }>(
    "/session",
    {
      schema: { body: signInBody },
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      onRequest: async (request) => {
        cookie.requireOrigin(request);
      },
    },
    async (request, reply) => {
      const result = await sessions.signIn(
        { ...request.body, username: request.body.username.trim() },
        cookie.read(request),
      );
      cookie.write(reply, result.handle);
      return { profile: result.profile };
    },
  );
  app.post(
    "/session/logout",
    {
      config: { rateLimit: anonymousRateLimit },
      onRequest: async (request) => {
        cookie.requireOrigin(request);
      },
    },
    async (request, reply) => {
      await sessions.signOut(cookie.read(request));
      cookie.clear(reply);
      return reply.code(204).send();
    },
  );
}
