import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { AgentActivity } from "../interface/agent-activity.js";
import { agentParams, type AgentParams } from "../schema/agent-request.js";
import { representAgent } from "../presenter/agent-presenter.js";

/** Expose recent teammates separately from profile reads, which must remain side-effect free. */
export async function agentActivityController(
  app: FastifyInstance,
  activity: AgentActivity,
): Promise<void> {
  app.get("/agents/recent", async (request) => ({
    agents: (await activity.recent(subject(request))).map(representAgent),
  }));
  app.post<{ Params: AgentParams }>(
    "/agents/:agentId/interactions",
    { schema: { params: agentParams } },
    async (request, reply) => {
      await activity.touch(subject(request), request.params.agentId);
      return reply.code(204).send();
    },
  );
}
