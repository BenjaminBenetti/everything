import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { ArtifactLibrary } from "../interface/artifact-library.js";
import {
  artifactViewBody,
  appParams,
  type AppParams,
  type ArtifactViewBody,
} from "../schema/artifact-request.js";

/** Register the browser's artifact endpoints: the shared library and links that open artifacts. */
export async function artifactController(
  app: FastifyInstance,
  artifacts: ArtifactLibrary,
): Promise<void> {
  app.get("/artifacts", async (request) => ({
    artifacts: await artifacts.list(subject(request)),
  }));

  app.post<{ Body: ArtifactViewBody }>(
    "/artifact-views",
    { schema: { body: artifactViewBody } },
    async (request) =>
      artifacts.view(subject(request), {
        slug: request.body.slug,
        ...(request.body.path !== undefined ? { path: request.body.path } : {}),
      }),
  );

  for (const action of ["start", "stop"] as const) {
    app.post<{ Params: AppParams }>(
      `/artifacts/:appId/${action}`,
      { schema: { params: appParams } },
      async (request, reply) => {
        await artifacts[action](subject(request), request.params.appId);
        return reply.code(204).send();
      },
    );
  }
  app.delete<{ Params: AppParams }>(
    "/artifacts/:appId",
    { schema: { params: appParams } },
    async (request, reply) => {
      await artifacts.delete(subject(request), request.params.appId);
      return reply.code(204).send();
    },
  );
}
