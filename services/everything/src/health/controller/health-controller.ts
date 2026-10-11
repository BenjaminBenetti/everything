import type { FastifyInstance } from "fastify";

/** Resolves when durable dependencies can serve requests; rejects otherwise. */
export type ReadinessCheck = () => Promise<void>;

/** Register unauthenticated Kubernetes probes, exempt from rate limiting. */
export async function healthController(
  app: FastifyInstance,
  readiness: ReadinessCheck,
): Promise<void> {
  app.get("/health/live", { config: { rateLimit: false } }, async () => ({
    status: "ok",
  }));

  app.get(
    "/health/ready",
    { config: { rateLimit: false } },
    async (_request, reply) => {
      try {
        await readiness();
        return { status: "ready" };
      } catch {
        return reply.code(503).send({ status: "unavailable" });
      }
    },
  );
}
