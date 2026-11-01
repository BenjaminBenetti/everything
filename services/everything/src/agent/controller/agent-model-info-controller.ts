import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import { agentParams, type AgentParams } from "../schema/agent-request.js";
import { agentModelInfoResponse } from "../schema/agent-model-info-response.js";
import type { AgentModelInfoReader } from "../interface/agent-model-info.js";

/** Read model details on demand without creating a runtime or making an inference request. */
export async function agentModelInfoController(
  app: FastifyInstance,
  info: AgentModelInfoReader,
): Promise<void> {
  app.get<{ Params: AgentParams }>(
    "/agents/:agentId/model-info",
    {
      schema: {
        summary: "Read the teammate's selected and applied model details",
        params: agentParams,
        response: { 200: agentModelInfoResponse },
      },
    },
    (request) => info.read(subject(request), request.params.agentId),
  );
}
