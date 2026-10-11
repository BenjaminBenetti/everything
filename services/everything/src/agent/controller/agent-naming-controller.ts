import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { AgentNaming } from "../interface/agent-naming.js";
import {
  agentParams,
  renameAgentBody,
  type AgentParams,
  type RenameAgentBody,
} from "../schema/agent-request.js";
import { representAgent } from "../presenter/agent-presenter.js";

/** Expose name changes without importing or invoking conversation operations. */
export async function agentNamingController(
  app: FastifyInstance,
  names: AgentNaming,
): Promise<void> {
  app.patch<{ Params: AgentParams; Body: RenameAgentBody }>(
    "/agents/:agentId",
    { schema: { params: agentParams, body: renameAgentBody } },
    async (request) =>
      representAgent(
        await names.rename(
          subject(request),
          request.params.agentId,
          request.body.name,
        ),
      ),
  );
}
