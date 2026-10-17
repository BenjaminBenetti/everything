import type { FastifyInstance } from "fastify";
import type { UpgradeOperations } from "../interface/upgrade-operations.js";
import {
  startUpgradeBody,
  upgradeStatusResponse,
  type StartUpgradeBody,
} from "../schema/upgrade-request.js";

/** Register the installation's version and the request to upgrade it. */
export async function upgradeController(
  app: FastifyInstance,
  upgrades: UpgradeOperations,
): Promise<void> {
  app.get(
    "/upgrade",
    {
      schema: {
        summary:
          "Read the installed version and whether a newer one is available",
        response: { 200: upgradeStatusResponse },
      },
    },
    async () => upgrades.status(),
  );
  app.post<{ Body: StartUpgradeBody }>(
    "/upgrade",
    {
      schema: {
        summary:
          "Upgrade the installation to a newer published version; Everything restarts while it upgrades",
        body: startUpgradeBody,
        response: { 202: upgradeStatusResponse },
      },
    },
    async (request, reply) =>
      reply.code(202).send(await upgrades.start(request.body)),
  );
}
