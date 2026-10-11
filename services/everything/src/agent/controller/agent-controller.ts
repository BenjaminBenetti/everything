import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { AgentCatalog } from "../interface/agent-catalog.js";
import type { AgentRemoval } from "../interface/agent-removal.js";
import type { AgentDefinition } from "../model/agent.js";
import {
  agentParams,
  createAgentBody,
  type AgentParams,
  type CreateAgentBody,
} from "../schema/agent-request.js";

/** Exclude ownership and deployment storage details from public agent representations. */
function representAgent(agent: AgentDefinition) {
  const { id, name, systemPrompt, createdAt } = agent;
  return { id, name, systemPrompt, createdAt };
}

/** Register agent definition endpoints; deletion goes through AgentRemoval so the runtime stops first. */
export async function agentController(
  app: FastifyInstance,
  agents: Omit<AgentCatalog, "delete">,
  removal: AgentRemoval,
): Promise<void> {
  app.get("/agents", async (request) => ({
    agents: (await agents.list(subject(request))).map(representAgent),
  }));

  app.post<{ Body: CreateAgentBody }>(
    "/agents",
    { schema: { body: createAgentBody } },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          representAgent(await agents.create(subject(request), request.body)),
        ),
  );

  app.get<{ Params: AgentParams }>(
    "/agents/:agentId",
    { schema: { params: agentParams } },
    async (request) =>
      representAgent(
        await agents.get(subject(request), request.params.agentId),
      ),
  );

  app.delete<{ Params: AgentParams }>(
    "/agents/:agentId",
    { schema: { params: agentParams } },
    async (request, reply) => {
      await removal.delete(subject(request), request.params.agentId);
      return reply.code(204).send();
    },
  );
}
