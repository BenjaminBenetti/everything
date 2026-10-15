import type { FastifyInstance } from "fastify";
import {
  artifactParams,
  type ArtifactParams,
} from "../../artifact/schema/artifact-request.js";
import type { ArtifactService } from "../../artifact/service/artifact-service.js";
import { requestActor } from "../../http/handler/actor.js";
import {
  deployBody,
  logsQuery,
  type DeployBody,
  type LogsQuery,
} from "../schema/deployment-request.js";
import type { DeploymentService } from "../service/deployment-service.js";

/** Lines of output returned when the caller does not ask for a number. */
const defaultLogLines = 200;

/** Register deployment and log endpoints of the internal API. */
export async function deploymentController(
  app: FastifyInstance,
  deployments: DeploymentService,
  artifacts: Pick<ArtifactService, "details">,
): Promise<void> {
  app.post<{ Params: ArtifactParams; Body: DeployBody }>(
    "/owners/:ownerId/artifacts/:artifact/deployments",
    { schema: { params: artifactParams, body: deployBody } },
    async (request) => {
      const { ownerId, artifact } = request.params;
      const deployed = await deployments.deploy(
        ownerId,
        requestActor(request),
        artifact,
        request.body,
      );
      return artifacts.details(ownerId, deployed.id);
    },
  );

  app.get<{ Params: ArtifactParams; Querystring: LogsQuery }>(
    "/owners/:ownerId/artifacts/:artifact/logs",
    { schema: { params: artifactParams, querystring: logsQuery } },
    async (request) => ({
      text: await deployments.logs(
        request.params.ownerId,
        request.params.artifact,
        {
          previous: request.query.previous === "true",
          lines: request.query.lines
            ? Number(request.query.lines)
            : defaultLogLines,
        },
      ),
    }),
  );
}
