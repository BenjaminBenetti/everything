import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { ArtifactLibrary } from "../interface/artifact-library.js";
import {
  artifactApiKeyResponse,
  artifactListResponse,
  artifactViewResponse,
} from "../schema/artifact-response.js";
import { noContentResponse } from "../../http/schema/http-response.js";
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
  app.get(
    "/artifacts",
    {
      schema: {
        summary: "List your apps",
        response: { 200: artifactListResponse },
      },
    },
    async (request) => ({
      artifacts: await artifacts.list(subject(request)),
    }),
  );

  app.post<{ Body: ArtifactViewBody }>(
    "/artifact-views",
    {
      schema: {
        summary: "Create a link to open an app",
        description:
          "Returns a URL that signs the viewer into the separate app origin and opens the requested path.",
        body: artifactViewBody,
        response: { 200: artifactViewResponse },
      },
    },
    async (request) =>
      artifacts.view(subject(request), {
        slug: request.body.slug,
        ...(request.body.path !== undefined ? { path: request.body.path } : {}),
      }),
  );

  for (const action of ["start", "stop"] as const) {
    app.post<{ Params: AppParams }>(
      `/artifacts/:appId/${action}`,
      {
        schema: {
          summary: `${action === "start" ? "Start" : "Stop"} an app`,
          params: appParams,
          response: { 204: noContentResponse },
        },
      },
      async (request, reply) => {
        await artifacts[action](subject(request), request.params.appId);
        return reply.code(204).send();
      },
    );
  }
  app.get<{ Params: AppParams }>(
    "/artifacts/:appId/api-key",
    {
      schema: {
        summary: "Show an app's API key",
        description:
          "Returns the current API key of a dynamic app with the API Key capability. External callers send it in the X-Api-Key header to reach that app on the app origin; it authenticates nothing else. Responses are never cached. A disabled capability, or a key still being set up, returns a conflict.",
        params: appParams,
        response: { 200: artifactApiKeyResponse },
      },
    },
    async (request, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .send(await artifacts.apiKey(subject(request), request.params.appId)),
  );

  app.delete<{ Params: AppParams }>(
    "/artifacts/:appId",
    {
      schema: {
        summary: "Delete a stopped app",
        description:
          "The app must be stopped before deletion; a running app returns a conflict.",
        params: appParams,
        response: { 204: noContentResponse },
      },
    },
    async (request, reply) => {
      await artifacts.delete(subject(request), request.params.appId);
      return reply.code(204).send();
    },
  );
}
