import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import {
  agentParams,
  type AgentParams,
} from "../../agent/schema/agent-request.js";
import {
  sendMessageBody,
  type SendMessageBody,
} from "../../conversation/schema/message-request.js";
import type { SubagentOperations } from "../interface/subagent-operations.js";
import {
  subagentListResponse,
  subagentResponse,
} from "../schema/subagent-response.js";
import { messagePageResponse } from "../../conversation/schema/message-response.js";
import { noContentResponse } from "../../http/schema/http-response.js";
import {
  createSubagentBody,
  subagentHistoryQuery,
  subagentParams,
  type CreateSubagentBody,
  type SubagentHistoryQuery,
  type SubagentParams,
} from "../schema/subagent-request.js";

/** Expose private background work to authenticated API consumers under the saved teammate. */
export async function subagentController(
  app: FastifyInstance,
  subagents: SubagentOperations,
): Promise<void> {
  const collection = "/agents/:agentId/subagent";
  const item = `${collection}/:subagentId`;
  app.post<{ Params: AgentParams; Body: CreateSubagentBody }>(
    `${collection}/wakeup`,
    {
      schema: {
        summary: "Handle a remote event in a temporary subagent",
        description:
          "Creates a private subagent, runs task through the normal tool loop, and returns before completion. context defaults to false; true copies the main session. Replies and final output can wake main. Once idle, the subagent, its descendants, and their transcripts are deleted. Cleanup also covers failure and cancellation; crashed temporary histories are removed on reopening without replay. Workspace files and messages already delivered to main remain. Each accepted request is a separate event; avoid duplicate submissions. Shares the eight-running-subagent limit; returns 409 at capacity and 503 when inference is unavailable.",
        params: agentParams,
        body: createSubagentBody,
        response: { 202: subagentResponse },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await subagents.wakeup(
            { ownerId: subject(request), agentId: request.params.agentId },
            request.body,
          ),
        ),
  );
  app.post<{ Params: AgentParams; Body: CreateSubagentBody }>(
    collection,
    {
      schema: {
        summary: "Create a private subagent",
        description:
          "Starts background work with the main teammate's settings, tools, and workspace. context defaults to false; true copies main's context. Returns immediately; private replies can wake main. Histories persist. At most eight subagents run concurrently; creation at capacity returns 409.",
        params: agentParams,
        body: createSubagentBody,
        response: { 201: subagentResponse },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await subagents.create(
            { ownerId: subject(request), agentId: request.params.agentId },
            request.body,
          ),
        ),
  );
  app.get<{ Params: AgentParams }>(
    collection,
    {
      schema: {
        summary: "List private subagents",
        description:
          "Includes nested and tool-created subagents in this teammate's family. Saved sessions are stopped after restart; listing needs no model provider.",
        params: agentParams,
        response: { 200: subagentListResponse },
      },
    },
    async (request) => ({
      subagents: await subagents.list({
        ownerId: subject(request),
        agentId: request.params.agentId,
      }),
    }),
  );
  app.delete<{ Params: SubagentParams }>(
    item,
    {
      schema: {
        summary: "Delete a private subagent and its descendants",
        description:
          "Stops work and removes the selected subtree's transcripts. Also works while the model provider is disconnected.",
        params: subagentParams,
        response: { 204: noContentResponse },
      },
    },
    async (request, reply) => {
      await subagents.delete(
        { ownerId: subject(request), agentId: request.params.agentId },
        request.params.subagentId,
      );
      return reply.code(204).send();
    },
  );
  app.post<{ Params: SubagentParams; Body: SendMessageBody }>(
    `${item}/messages`,
    {
      schema: {
        summary: "Message a private subagent",
        description:
          "Wakes an idle or stopped subagent, or queues behind its current turn without interrupting it. Queued input enters history when its turn starts and can be lost on stop or restart. Does not create a user message in main's conversation.",
        params: subagentParams,
        body: sendMessageBody,
        response: { 202: subagentResponse },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await subagents.send(
            { ownerId: subject(request), agentId: request.params.agentId },
            request.params.subagentId,
            request.body.text,
          ),
        ),
  );
  app.get<{ Params: SubagentParams; Querystring: SubagentHistoryQuery }>(
    `${item}/messages`,
    {
      schema: {
        summary: "Read private subagent history",
        description:
          "Latest 100 text messages, chronologically; pass nextCursor as before for earlier history. Excludes inherited parent context, thinking, arbitrary tools, and provider errors. Works without a model provider. Deleted or inaccessible sessions return 404.",
        params: subagentParams,
        querystring: subagentHistoryQuery,
        response: { 200: messagePageResponse },
      },
    },
    async (request) =>
      subagents.messages(
        { ownerId: subject(request), agentId: request.params.agentId },
        request.params.subagentId,
        request.query.before,
      ),
  );
}
