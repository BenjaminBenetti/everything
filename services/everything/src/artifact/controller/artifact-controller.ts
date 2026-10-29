import type { FastifyInstance, FastifyRequest } from "fastify";
import { subject } from "@everything/security/fastify";
import type { ArtifactLibrary } from "../interface/artifact-library.js";
import {
  artifactApiKeyResponse,
  artifactListResponse,
  artifactSummaryResponse,
  artifactViewResponse,
} from "../schema/artifact-response.js";
import { noContentResponse } from "../../http/schema/http-response.js";
import {
  appVisibilityBody,
  artifactViewBody,
  appParams,
  type AppParams,
  type AppVisibilityBody,
  type ArtifactViewBody,
} from "../schema/artifact-request.js";

/** Refuses a request unless a person signed in to the application in their browser made it. */
export type SignedInUserCheck = (request: FastifyRequest) => void;

/**
 * Register the browser's artifact endpoints: the shared library, links that open artifacts, and the
 * owner's lifecycle and sharing controls.
 */
export async function artifactController(
  app: FastifyInstance,
  artifacts: ArtifactLibrary,
  requireSignedInUser: SignedInUserCheck,
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

  app.put<{ Params: AppParams; Body: AppVisibilityBody }>(
    "/artifacts/:appId/visibility",
    {
      schema: {
        summary: "Make an app private or public",
        description:
          "Only a person signed in to Everything in a browser can change this, from the application's own origin; app tokens, teammates, and other bearer tokens are refused even for the owner's own apps. A public app's link works for anyone without signing in, for its pages and endpoints; a private app opens only for you and your teammates. Apps start private, and later releases keep the choice.",
        params: appParams,
        body: appVisibilityBody,
        response: { 200: artifactSummaryResponse },
      },
      onRequest: async (request) => {
        requireSignedInUser(request);
      },
    },
    async (request) =>
      artifacts.setVisibility(
        subject(request),
        request.params.appId,
        request.body.visibility,
      ),
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
