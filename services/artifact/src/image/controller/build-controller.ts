import type { FastifyInstance } from "fastify";
import {
  artifactParams,
  type ArtifactParams,
} from "../../artifact/schema/artifact-request.js";
import { requestActor } from "../../http/handler/actor.js";
import {
  buildParams,
  startBuildBody,
  type BuildParams,
  type StartBuildBody,
} from "../schema/build-request.js";
import type { BuildService } from "../service/build-service.js";

/** Register image build endpoints of the internal API. */
export async function buildController(
  app: FastifyInstance,
  builds: BuildService,
): Promise<void> {
  app.post<{ Params: ArtifactParams; Body: StartBuildBody }>(
    "/owners/:ownerId/artifacts/:artifact/builds",
    { schema: { params: artifactParams, body: startBuildBody } },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await builds.start(
            request.params.ownerId,
            requestActor(request),
            request.params.artifact,
            request.body,
          ),
        ),
  );

  app.get<{ Params: BuildParams }>(
    "/owners/:ownerId/artifacts/:artifact/builds/:number",
    { schema: { params: buildParams } },
    async (request) =>
      builds.get(
        request.params.ownerId,
        request.params.artifact,
        Number(request.params.number),
      ),
  );
}
