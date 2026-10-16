import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { AgentActivity } from "../interface/agent-activity.js";
import { agentParams, type AgentParams } from "../schema/agent-request.js";
import { representAgent } from "../presenter/agent-presenter.js";
import { agentListResponse } from "../schema/agent-response.js";
import { noContentResponse } from "../../http/schema/http-response.js";

/** Expose recent teammates separately from profile reads, which must remain side-effect free. */
export async function agentActivityController(
  app: FastifyInstance,
  activity: AgentActivity,
): Promise<void> {
  app.get(
    "/agents/recent",
    {
      schema: {
        summary: "List your recently used teammates",
        response: { 200: agentListResponse },
      },
    },
    async (request) => ({
      agents: (await activity.recent(subject(request))).map(representAgent),
    }),
  );
  app.post<{ Params: AgentParams }>(
    "/agents/:agentId/interactions",
    {
      schema: {
        summary: "Record an interaction with a teammate",
        params: agentParams,
        response: { 204: noContentResponse },
      },
    },
    async (request, reply) => {
      await activity.touch(subject(request), request.params.agentId);
      return reply.code(204).send();
    },
  );
}
