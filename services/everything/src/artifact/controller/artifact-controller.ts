import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { ArtifactLibrary } from "../interface/artifact-library.js";
import {
  artifactViewBody,
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
}
