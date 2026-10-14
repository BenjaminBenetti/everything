import type { FastifyInstance } from "fastify";
import type { WorkerSettingsOperations } from "../interface/worker-settings.js";
import {
  workerSettingsBody,
  type WorkerSettingsBody,
} from "../schema/settings-request.js";

/** Register the workspace's settings: how the workers teammates run work in are set up. */
export async function settingsController(
  app: FastifyInstance,
  workers: WorkerSettingsOperations,
): Promise<void> {
  app.get("/settings/workers", async () => workers.read());

  app.put<{ Body: WorkerSettingsBody }>(
    "/settings/workers",
    { schema: { body: workerSettingsBody } },
    async (request) => workers.update({ privileged: request.body.privileged }),
  );
}
