import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import {
  agentParams,
  type AgentParams,
} from "../../agent/schema/agent-request.js";
import type { ConversationOperations } from "../interface/conversation-operations.js";
import {
  messagePageResponse,
  messageReceiptResponse,
  runtimeStatusResponse,
} from "../schema/message-response.js";
import {
  sendMessageBody,
  messageHistoryQuery,
  type MessageHistoryQuery,
  type SendMessageBody,
} from "../schema/message-request.js";

/** Register visible-message and interruption endpoints independently of agent definitions. */
export async function conversationController(
  app: FastifyInstance,
  conversations: ConversationOperations,
): Promise<void> {
  app.get<{ Params: AgentParams; Querystring: MessageHistoryQuery }>(
    "/agents/:agentId/messages",
    {
      schema: {
        summary: "Read the teammate's ongoing conversation",
        description:
          "Returns the latest 100 visible messages chronologically. Pass nextCursor as before for the preceding page; inaccessible cursors return an empty page.",
        params: agentParams,
        querystring: messageHistoryQuery,
        response: { 200: messagePageResponse },
      },
    },
    async (request) =>
      conversations.list(
        subject(request),
        request.params.agentId,
        request.query.before,
      ),
  );

  app.post<{ Params: AgentParams; Body: SendMessageBody }>(
    "/agents/:agentId/messages",
    {
      schema: {
        summary: "Send a visible user message",
        description:
          "Persists the message, interrupts the active main turn, and starts a new turn. Background subagents keep running. Returns before inference completes.",
        params: agentParams,
        body: sendMessageBody,
        response: { 202: messageReceiptResponse },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await conversations.send(
            subject(request),
            request.params.agentId,
            request.body.text,
          ),
        ),
  );

  app.get<{ Params: AgentParams }>(
    "/agents/:agentId/runtime",
    {
      schema: {
        summary: "Read the teammate's runtime status",
        params: agentParams,
        response: { 200: runtimeStatusResponse },
      },
    },
    async (request) =>
      conversations.status(subject(request), request.params.agentId),
  );

  app.post<{ Params: AgentParams }>(
    "/agents/:agentId/interrupt",
    {
      schema: {
        summary: "Stop the teammate and its background work",
        description:
          "Cancels generation and compaction, stops all private subagents, and clears queued work. Retained histories remain; temporary wakeup sessions are deleted.",
        params: agentParams,
        response: { 200: runtimeStatusResponse },
      },
    },
    async (request) => {
      await conversations.interrupt(subject(request), request.params.agentId);
      return conversations.status(subject(request), request.params.agentId);
    },
  );
}
