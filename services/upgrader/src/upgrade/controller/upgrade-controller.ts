import type { FastifyInstance } from "fastify";
import type { UpgradeOperations } from "../interface/upgrade-operations.js";
import {
  startUpgradeBody,
  upgradeStatusResponse,
  type StartUpgradeBody,
} from "../schema/upgrade-request.js";

/** Register the upgrade routes; the caller's identity is checked by the enclosing scope. */
export async function upgradeController(
  app: FastifyInstance,
  upgrades: UpgradeOperations,
): Promise<void> {
  app.get(
    "/upgrade",
    { schema: { response: { 200: upgradeStatusResponse } } },
    async () => upgrades.status(),
  );
  app.post<{ Body: StartUpgradeBody }>(
    "/upgrade",
    {
      schema: {
        body: startUpgradeBody,
        response: { 202: upgradeStatusResponse },
      },
    },
    async (request, reply) =>
      reply.code(202).send(await upgrades.start(request.body)),
  );
}
