import type { FastifyInstance } from "fastify";
import { requestActor } from "../../http/handler/actor.js";
import {
  artifactParams,
  type ArtifactParams,
} from "../schema/artifact-request.js";
import type { ArtifactLifecycleService } from "../service/artifact-lifecycle-service.js";
import type { ArtifactService } from "../service/artifact-service.js";

/** Register scoped start and stop operations for both static and dynamic apps. */
export async function artifactLifecycleController(
  app: FastifyInstance,
  lifecycle: Pick<ArtifactLifecycleService, "start" | "stop">,
  artifacts: Pick<ArtifactService, "details">,
): Promise<void> {
  for (const action of ["start", "stop"] as const) {
    app.post<{ Params: ArtifactParams }>(
      `/owners/:ownerId/artifacts/:artifact/${action}`,
      { schema: { params: artifactParams } },
      async (request) => {
        const { ownerId, artifact } = request.params;
        const updated = await lifecycle[action](
          ownerId,
          requestActor(request),
          artifact,
        );
        return artifacts.details(ownerId, updated.id);
      },
    );
  }
}
