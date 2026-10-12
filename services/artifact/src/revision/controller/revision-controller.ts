import type { FastifyInstance } from "fastify";
import {
  artifactParams,
  type ArtifactParams,
} from "../../artifact/schema/artifact-request.js";
import type { ArtifactService } from "../../artifact/service/artifact-service.js";
import { requestActor } from "../../http/handler/actor.js";
import {
  activateRevisionBody,
  publishRevisionBody,
  revisionParams,
  type ActivateRevisionBody,
  type PublishRevisionBody,
  type RevisionParams,
} from "../schema/revision-request.js";
import type { RevisionService } from "../service/revision-service.js";

/** Register static artifact publishing endpoints of the internal API. */
export async function revisionController(
  app: FastifyInstance,
  revisions: RevisionService,
  artifacts: Pick<ArtifactService, "details">,
): Promise<void> {
  app.post<{ Params: ArtifactParams; Body: PublishRevisionBody }>(
    "/owners/:ownerId/artifacts/:artifact/revisions",
    { schema: { params: artifactParams, body: publishRevisionBody } },
    async (request, reply) => {
      const { ownerId, artifact } = request.params;
      const published = await revisions.publish(
        ownerId,
        requestActor(request),
        artifact,
        {
          files: request.body.files,
          ...(request.body.basedOn !== undefined
            ? { basedOn: request.body.basedOn }
            : {}),
        },
      );
      return reply
        .code(201)
        .send(await artifacts.details(ownerId, published.id));
    },
  );

  app.post<{ Params: RevisionParams; Body: ActivateRevisionBody }>(
    "/owners/:ownerId/artifacts/:artifact/revisions/:number/activate",
    { schema: { params: revisionParams, body: activateRevisionBody } },
    async (request) => {
      const { ownerId, artifact, number } = request.params;
      const activated = await revisions.activate(
        ownerId,
        requestActor(request),
        artifact,
        Number(number),
        request.body.basedOn !== undefined
          ? { basedOn: request.body.basedOn }
          : {},
      );
      return artifacts.details(ownerId, activated.id);
    },
  );
}
