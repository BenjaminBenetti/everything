import type { FastifyInstance } from "fastify";
import type { WorkspaceInstances } from "../interface/workspace-instances.js";
import {
  workspaceInstanceBody,
  type WorkspaceInstanceBody,
} from "../schema/workspace-instance-request.js";

/** Expose the installation's shared workspaces inside the authenticated API. */
export async function workspaceInstanceController(
  app: FastifyInstance,
  workspaces: WorkspaceInstances,
): Promise<void> {
  app.get("/workspaces", async () => ({ workspaces: await workspaces.list() }));
  for (const action of ["start", "stop"] as const) {
    app.post<{ Body: WorkspaceInstanceBody }>(
      `/workspaces/${action}`,
      { schema: { body: workspaceInstanceBody } },
      async (request, reply) => {
        await workspaces[action](request.body);
        return reply.status(204).send();
      },
    );
  }
  app.delete<{ Body: WorkspaceInstanceBody }>(
    "/workspaces",
    { schema: { body: workspaceInstanceBody } },
    async (request, reply) => {
      await workspaces.delete(request.body);
      return reply.status(202).send({});
    },
  );
}
