import type { FastifyInstance } from "fastify";
import {
  artifactParams,
  type ArtifactParams,
} from "../../artifact/schema/artifact-request.js";
import type { ArtifactService } from "../../artifact/service/artifact-service.js";
import { requestActor } from "../../http/handler/actor.js";
import {
  appCredentialParams,
  credentialGrant,
  type AppCredentialParams,
  type CredentialGrantBody,
} from "../schema/credential-request.js";
import type { AppCredentials } from "../service/app-credentials.js";

/** Register the internal endpoints that give one app a credential or take it away. */
export async function appCredentialController(
  app: FastifyInstance,
  credentials: Pick<AppCredentials, "attach" | "detach">,
  artifacts: Pick<ArtifactService, "details">,
): Promise<void> {
  app.post<{ Params: ArtifactParams; Body: CredentialGrantBody }>(
    "/owners/:ownerId/artifacts/:artifact/credentials",
    { schema: { params: artifactParams, body: credentialGrant } },
    async (request) => {
      const { ownerId, artifact } = request.params;
      const changed = await credentials.attach(
        ownerId,
        requestActor(request),
        artifact,
        request.body,
      );
      return artifacts.details(ownerId, changed.id);
    },
  );

  app.delete<{ Params: AppCredentialParams }>(
    "/owners/:ownerId/artifacts/:artifact/credentials/:env",
    { schema: { params: appCredentialParams } },
    async (request) => {
      const { ownerId, artifact, env } = request.params;
      const changed = await credentials.detach(
        ownerId,
        requestActor(request),
        artifact,
        env,
      );
      return artifacts.details(ownerId, changed.id);
    },
  );
}
