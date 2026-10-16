import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import {
  agentParams,
  type AgentParams,
} from "../../agent/schema/agent-request.js";
import type { WorkspaceActivityReader } from "../interface/workspace-activity.js";
import { recentWorkspacesResponse } from "../schema/workspace-response.js";

/** Expose only the authenticated owner's teammate activity; GET never counts as an interaction. */
export async function workspaceActivityController(
  app: FastifyInstance,
  activity: WorkspaceActivityReader,
): Promise<void> {
  app.get<{ Params: AgentParams }>(
    "/agents/:agentId/workspaces",
    {
      schema: {
        summary: "Read a teammate's recent workspace activity",
        params: agentParams,
        response: { 200: recentWorkspacesResponse },
      },
    },
    async (request) =>
      activity.recent({
        ownerId: subject(request),
        agentId: request.params.agentId,
      }),
  );
}
