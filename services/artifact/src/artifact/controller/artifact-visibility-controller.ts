import type { FastifyInstance } from "fastify";
import { requestActor } from "../../http/handler/actor.js";
import {
  artifactParams,
  visibilityBody,
  type ArtifactParams,
  type VisibilityBody,
} from "../schema/artifact-request.js";
import type { ArtifactService } from "../service/artifact-service.js";
import type { ArtifactVisibilityService } from "../service/artifact-visibility-service.js";

/** Register the owner's change of who can open an app, separate from every create, edit, and release. */
export async function artifactVisibilityController(
  app: FastifyInstance,
  visibility: Pick<ArtifactVisibilityService, "change">,
  artifacts: Pick<ArtifactService, "details">,
): Promise<void> {
  app.put<{ Params: ArtifactParams; Body: VisibilityBody }>(
    "/owners/:ownerId/artifacts/:artifact/visibility",
    { schema: { params: artifactParams, body: visibilityBody } },
    async (request) => {
      const { ownerId, artifact } = request.params;
      const updated = await visibility.change(
        ownerId,
        requestActor(request),
        artifact,
        request.body.visibility,
      );
      return artifacts.details(ownerId, updated.id);
    },
  );
}
