import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import {
  agentParams,
  type AgentParams,
} from "../../agent/schema/agent-request.js";
import type { UpdateOperations } from "../interface/update-operations.js";
import {
  readMessagesBody,
  updateFeedQuery,
  type ReadMessagesBody,
  type UpdateFeedQuery,
} from "../schema/update-request.js";

/** Keep reading the feed and its count separate from the explicit receipt mutation. */
export async function updateController(
  app: FastifyInstance,
  updates: UpdateOperations,
): Promise<void> {
  app.get<{ Querystring: UpdateFeedQuery }>(
    "/updates",
    { schema: { querystring: updateFeedQuery } },
    (request) => updates.list(subject(request), request.query.before),
  );

  app.get("/updates/count", (request) => updates.count(subject(request)));

  app.get<{ Querystring: UpdateFeedQuery }>(
    "/updates/seen",
    { schema: { querystring: updateFeedQuery } },
    (request) => updates.seen(subject(request), request.query.before),
  );

  app.post<{ Params: AgentParams; Body: ReadMessagesBody }>(
    "/agents/:agentId/messages/read",
    { schema: { params: agentParams, body: readMessagesBody } },
    async (request, reply) => {
      await updates.read(
        subject(request),
        request.params.agentId,
        request.body.messageIds,
      );
      return reply.code(204).send();
    },
  );
}
