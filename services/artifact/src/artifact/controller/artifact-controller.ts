import type { FastifyInstance } from "fastify";
import { requestActor } from "../../http/handler/actor.js";
import {
  artifactParams,
  createArtifactBody,
  deleteArtifactQuery,
  ownerParams,
  sourceQuery,
  updateArtifactBody,
  type ArtifactParams,
  type CreateArtifactBody,
  type DeleteArtifactQuery,
  type OwnerParams,
  type SourceQuery,
  type UpdateArtifactBody,
} from "../schema/artifact-request.js";
import type { ArtifactService } from "../service/artifact-service.js";

/** Register artifact record endpoints of the internal API. */
export async function artifactController(
  app: FastifyInstance,
  artifacts: ArtifactService,
): Promise<void> {
  app.get<{ Params: OwnerParams }>(
    "/owners/:ownerId/artifacts",
    { schema: { params: ownerParams } },
    async (request) => ({
      artifacts: await artifacts.list(request.params.ownerId),
    }),
  );

  app.post<{ Params: OwnerParams; Body: CreateArtifactBody }>(
    "/owners/:ownerId/artifacts",
    { schema: { params: ownerParams, body: createArtifactBody } },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await artifacts.create(
            request.params.ownerId,
            requestActor(request),
            request.body,
          ),
        ),
  );

  app.get<{ Params: ArtifactParams }>(
    "/owners/:ownerId/artifacts/:artifact",
    { schema: { params: artifactParams } },
    async (request) =>
      artifacts.details(request.params.ownerId, request.params.artifact),
  );

  app.patch<{ Params: ArtifactParams; Body: UpdateArtifactBody }>(
    "/owners/:ownerId/artifacts/:artifact",
    { schema: { params: artifactParams, body: updateArtifactBody } },
    async (request) =>
      artifacts.update(
        request.params.ownerId,
        requestActor(request),
        request.params.artifact,
        request.body,
      ),
  );

  app.delete<{ Params: ArtifactParams; Querystring: DeleteArtifactQuery }>(
    "/owners/:ownerId/artifacts/:artifact",
    { schema: { params: artifactParams, querystring: deleteArtifactQuery } },
    async (request, reply) => {
      requestActor(request);
      await artifacts.delete(
        request.params.ownerId,
        request.params.artifact,
        request.query.requireStopped === "true",
      );
      return reply.code(204).send();
    },
  );

  app.get<{ Params: ArtifactParams; Querystring: SourceQuery }>(
    "/owners/:ownerId/artifacts/:artifact/source",
    { schema: { params: artifactParams, querystring: sourceQuery } },
    async (request) =>
      artifacts.source(request.params.ownerId, request.params.artifact, {
        ...(request.query.revision
          ? { revision: Number(request.query.revision) }
          : {}),
        ...(request.query.build ? { build: Number(request.query.build) } : {}),
      }),
  );
}
