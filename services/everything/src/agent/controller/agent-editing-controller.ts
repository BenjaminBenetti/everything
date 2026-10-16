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
import { agentResponse } from "../schema/agent-response.js";

/** Expose saved profile changes independently of conversation operations. */
export async function agentEditingController(
  app: FastifyInstance,
  profiles: AgentEditing,
): Promise<void> {
  app.patch<{ Params: AgentParams; Body: UpdateAgentBody }>(
    "/agents/:agentId",
    {
      schema: {
        summary: "Update a teammate profile",
        description:
          "Omitted fields retain their values. Runtime settings apply on the next user turn in the same ongoing conversation.",
        params: agentParams,
        body: updateAgentBody,
        response: { 200: agentResponse },
      },
    },
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
