import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { AgentEditing } from "../interface/agent-editing.js";
import {
  agentParams,
  updateAgentBody,
  type AgentParams,
  type UpdateAgentBody,
} from "../schema/agent-request.js";
import { representAgent } from "../presenter/agent-presenter.js";

/** Expose saved profile changes independently of conversation operations. */
export async function agentEditingController(
  app: FastifyInstance,
  profiles: AgentEditing,
): Promise<void> {
  app.patch<{ Params: AgentParams; Body: UpdateAgentBody }>(
    "/agents/:agentId",
    { schema: { params: agentParams, body: updateAgentBody } },
    async (request) =>
      representAgent(
        await profiles.update(
          subject(request),
          request.params.agentId,
          request.body,
        ),
      ),
  );
}
