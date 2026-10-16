import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { AgentCatalog } from "../interface/agent-catalog.js";
import type { AgentRemoval } from "../interface/agent-removal.js";
import { representAgent } from "../presenter/agent-presenter.js";
import { agentListResponse, agentResponse } from "../schema/agent-response.js";
import { noContentResponse } from "../../http/schema/http-response.js";
import {
  agentParams,
  createAgentBody,
  type AgentParams,
  type CreateAgentBody,
} from "../schema/agent-request.js";

/** Register agent definition endpoints; deletion goes through AgentRemoval so the runtime stops first. */
export async function agentController(
  app: FastifyInstance,
  agents: Omit<AgentCatalog, "delete">,
  removal: AgentRemoval,
): Promise<void> {
  app.get(
    "/agents",
    {
      schema: {
        summary: "List your teammates",
        response: { 200: agentListResponse },
      },
    },
    async (request) => ({
      agents: (await agents.list(subject(request))).map(representAgent),
    }),
  );

  app.post<{ Body: CreateAgentBody }>(
    "/agents",
    {
      schema: {
        summary: "Create a teammate",
        description:
          "Saves a profile and provisions its workspace. Inference must be selected before sending messages or starting background work.",
        body: createAgentBody,
        response: { 201: agentResponse },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          representAgent(await agents.create(subject(request), request.body)),
        ),
  );

  app.get<{ Params: AgentParams }>(
    "/agents/:agentId",
    {
      schema: {
        summary: "Read a teammate profile",
        params: agentParams,
        response: { 200: agentResponse },
      },
    },
    async (request) =>
      representAgent(
        await agents.get(subject(request), request.params.agentId),
      ),
  );

  app.delete<{ Params: AgentParams }>(
    "/agents/:agentId",
    {
      schema: {
        summary: "Delete a teammate",
        description:
          "Stops its runtime and removes its saved messages, private sessions, workspace, and tools pod.",
        params: agentParams,
        response: { 204: noContentResponse },
      },
    },
    async (request, reply) => {
      await removal.delete(subject(request), request.params.agentId);
      return reply.code(204).send();
    },
  );
}
