import type { FastifyInstance } from "fastify";
import {
  artifactParams,
  type ArtifactParams,
} from "../../artifact/schema/artifact-request.js";
import { viewPassBody, type ViewPassBody } from "../schema/view-request.js";
import type { ViewPasses } from "../service/view-passes.js";

/** Register the internal endpoint issuing teammate passes that view one artifact inside the cluster. */
export async function viewPassController(
  app: FastifyInstance,
  passes: Pick<ViewPasses, "issue">,
): Promise<void> {
  app.post<{ Params: ArtifactParams; Body: ViewPassBody }>(
    "/owners/:ownerId/artifacts/:artifact/view-passes",
    { schema: { params: artifactParams, body: viewPassBody } },
    async (request, reply) =>
      reply
        .code(201)
        .header("Cache-Control", "no-store")
        .send(
          await passes.issue(request.params.ownerId, request.params.artifact, {
            ...(request.body.path !== undefined
              ? { path: request.body.path }
              : {}),
          }),
        ),
  );
}
