import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import {
  agentParams,
  type AgentParams,
} from "../../agent/schema/agent-request.js";
import type { WorkspaceActivityReader } from "../interface/workspace-activity.js";

/** Expose only the authenticated owner's teammate activity; GET never counts as an interaction. */
export async function workspaceActivityController(
  app: FastifyInstance,
  activity: WorkspaceActivityReader,
): Promise<void> {
  app.get<{ Params: AgentParams }>(
    "/agents/:agentId/workspaces",
    { schema: { params: agentParams } },
    async (request) =>
      activity.recent({
        ownerId: subject(request),
        agentId: request.params.agentId,
      }),
  );
}
