import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import {
  agentParams,
  type AgentParams,
} from "../../agent/schema/agent-request.js";
import type { ConversationOperations } from "../interface/conversation-operations.js";
import {
  sendMessageBody,
  type SendMessageBody,
} from "../schema/message-request.js";

/** Register visible-message and interruption endpoints independently of agent definitions. */
export async function conversationController(
  app: FastifyInstance,
  conversations: ConversationOperations,
): Promise<void> {
  app.get<{ Params: AgentParams }>(
    "/agents/:agentId/messages",
    { schema: { params: agentParams } },
    async (request) => ({
      messages: await conversations.list(
        subject(request),
        request.params.agentId,
      ),
    }),
  );

  app.post<{ Params: AgentParams; Body: SendMessageBody }>(
    "/agents/:agentId/messages",
    { schema: { params: agentParams, body: sendMessageBody } },
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
    { schema: { params: agentParams } },
    async (request) =>
      conversations.status(subject(request), request.params.agentId),
  );

  app.post<{ Params: AgentParams }>(
    "/agents/:agentId/interrupt",
    { schema: { params: agentParams } },
    async (request) => {
      await conversations.interrupt(subject(request), request.params.agentId);
      return conversations.status(subject(request), request.params.agentId);
    },
  );
}
