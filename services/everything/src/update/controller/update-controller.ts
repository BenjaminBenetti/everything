import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import {
  agentParams,
  type AgentParams,
} from "../../agent/schema/agent-request.js";
import {
  messageHistoryQuery,
  type MessageHistoryQuery,
} from "../../conversation/schema/message-request.js";
import type { UpdateOperations } from "../interface/update-operations.js";
import {
  readMessagesBody,
  type ReadMessagesBody,
} from "../schema/update-request.js";

/** Keep fetching previews separate from the explicit receipt mutation. */
export async function updateController(
  app: FastifyInstance,
  updates: UpdateOperations,
): Promise<void> {
  app.get<{ Querystring: MessageHistoryQuery }>(
    "/updates",
    {
      schema: { querystring: messageHistoryQuery },
    },
    (request) => updates.list(subject(request), request.query.before),
  );

  app.post<{ Params: AgentParams; Body: ReadMessagesBody }>(
    "/agents/:agentId/messages/read",
    {
      schema: { params: agentParams, body: readMessagesBody },
    },
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
