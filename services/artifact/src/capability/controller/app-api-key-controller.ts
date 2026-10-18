import type { FastifyInstance } from "fastify";
import {
  artifactParams,
  type ArtifactParams,
} from "../../artifact/schema/artifact-request.js";
import type { AppApiKeys } from "../service/app-api-keys.js";

/** Register the internal endpoint that shows the owner a dynamic app's API key. */
export async function appApiKeyController(
  app: FastifyInstance,
  keys: Pick<AppApiKeys, "reveal">,
): Promise<void> {
  app.get<{ Params: ArtifactParams }>(
    "/owners/:ownerId/artifacts/:artifact/api-key",
    { schema: { params: artifactParams } },
    async (request, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .send(
          await keys.reveal(request.params.ownerId, request.params.artifact),
        ),
  );
}
