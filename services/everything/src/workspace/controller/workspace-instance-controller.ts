import type { FastifyInstance } from "fastify";
import type { WorkspaceInstances } from "../interface/workspace-instances.js";
import {
  workspaceDeletionResponse,
  workspaceListResponse,
} from "../schema/workspace-response.js";
import { noContentResponse } from "../../http/schema/http-response.js";
import {
  workspaceInstanceBody,
  type WorkspaceInstanceBody,
} from "../schema/workspace-instance-request.js";

/** Expose the installation's shared workspaces inside the authenticated API. */
export async function workspaceInstanceController(
  app: FastifyInstance,
  workspaces: WorkspaceInstances,
): Promise<void> {
  app.get(
    "/workspaces",
    {
      schema: {
        summary: "List installation-wide workspaces",
        response: { 200: workspaceListResponse },
      },
    },
    async () => ({ workspaces: await workspaces.list() }),
  );
  for (const action of ["start", "stop"] as const) {
    app.post<{ Body: WorkspaceInstanceBody }>(
      `/workspaces/${action}`,
      {
        schema: {
          summary: `${action === "start" ? "Start" : "Stop"} a workspace`,
          body: workspaceInstanceBody,
          response: { 204: noContentResponse },
        },
      },
      async (request, reply) => {
        await workspaces[action](request.body);
        return reply.status(204).send();
      },
    );
  }
  app.delete<{ Body: WorkspaceInstanceBody }>(
    "/workspaces",
    {
      schema: {
        summary: "Delete a workspace asynchronously",
        body: workspaceInstanceBody,
        response: { 202: workspaceDeletionResponse },
      },
    },
    async (request, reply) => {
      await workspaces.delete(request.body);
      return reply.status(202).send({});
    },
  );
}
