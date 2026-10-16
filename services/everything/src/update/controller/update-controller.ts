import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import {
  agentParams,
  type AgentParams,
} from "../../agent/schema/agent-request.js";
import type { UpdateOperations } from "../interface/update-operations.js";
import {
  updateCountResponse,
  updatePageResponse,
} from "../schema/update-response.js";
import { noContentResponse } from "../../http/schema/http-response.js";
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
    {
      schema: {
        summary: "Read unread updates",
        description:
          "Newest first, up to 50 per page. Pass nextCursor as before to continue; reading does not mark updates as seen.",
        querystring: updateFeedQuery,
        response: { 200: updatePageResponse },
      },
    },
    (request) => updates.list(subject(request), request.query.before),
  );

  app.get(
    "/updates/count",
    {
      schema: {
        summary: "Count unread updates",
        response: { 200: updateCountResponse },
      },
    },
    (request) => updates.count(subject(request)),
  );

  app.get<{ Querystring: UpdateFeedQuery }>(
    "/updates/seen",
    {
      schema: {
        summary: "Read previously seen updates",
        querystring: updateFeedQuery,
        response: { 200: updatePageResponse },
      },
    },
    (request) => updates.seen(subject(request), request.query.before),
  );

  app.post<{ Params: AgentParams; Body: ReadMessagesBody }>(
    "/agents/:agentId/messages/read",
    {
      schema: {
        summary: "Mark specified messages as read",
        params: agentParams,
        body: readMessagesBody,
        response: { 204: noContentResponse },
      },
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
