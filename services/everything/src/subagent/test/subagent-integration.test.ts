import { testApiDocumentation } from "../../runtime/test/api-documentation-fixtures.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { requireAuthentication } from "@everything/security/fastify";
import { errorHandler } from "@everything/errors/fastify";
import {
  everythingAppClaims,
  everythingAppClientId,
} from "@everything/artifact-contracts/everything-api";
import type { ChatMessage } from "@everything/conversation-contracts";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
import { ConversationService } from "../../conversation/service/conversation-service.js";
import { strictRequestValidation } from "../../http/config/request-validation.js";
import { appIdentity } from "../../identity/service/app-identity.js";
import { PiInferenceRuntimeFactory } from "../../runtime/adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";
import { PiSessionFactory } from "../../runtime/adapter/pi-session-factory.js";
import { createModelRuntime } from "../../runtime/factory/model-runtime.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import { PiSubagentArchives } from "../adapter/pi-subagent-archives.js";
import { subagentController } from "../controller/subagent-controller.js";
import { SubagentService } from "../service/subagent-service.js";

/** Return a deterministic provider event while exercising Pi's real tool and persistence paths. */
function completion(
  text: string,
  tool?: { name: string; input: unknown },
): Response {
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: `call-${randomUUID()}`,
            type: "function",
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.input),
            },
          },
        ],
      }
    : { content: text };
  return new Response(
    `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "o3-mini", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Wait for asynchronous private work with a bounded deadline. */
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Private background work did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("app-authenticated subagent API runs private Pi sessions, wakes main, survives restart, and enforces ownership", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "subagent-api-"));
  const apps: FastifyInstance[] = [];
  const services: ConversationService[] = [];
  context.after(async () => {
    for (const app of apps) await app.close();
    for (const service of services) await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const agentId: string = randomUUID();
  const otherAgentId: string = randomUUID();
  const appId = randomUUID();
  const definition: AgentDefinition = {
    id: agentId,
    ownerId: "owner",
    name: "API test teammate",
    systemPrompt: "Handle private background work",
    avatarId: "avatar-01",
    createdAt: new Date().toISOString(),
    inference: {
      provider: "openai-compatible",
      model: "o3-mini",
      effort: "high",
    },
  };
  const visible: ChatMessage[] = [];
  let opened = 0;
  let requests = 0;
  let working = false;
  let release!: () => void;
  const inference = new PiInferenceRuntimeFactory(
    {
      access: async (ownerId) => {
        assert.equal(ownerId, "owner");
        return {
          credential: { apiKey: "fixture-key" },
          baseUrl: "http://model.test/v1",
          model: "o3-mini",
        };
      },
    },
    { select: async () => ({ id: "o3-mini", name: "Test" }) },
    new PiModelCapabilities(await createModelRuntime()),
    async (_input, init) => {
      requests++;
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content?: unknown }[];
      };
      const fork = String(body.messages[0]!.content).includes(
        "You are private fork ",
      );
      const last = body.messages.at(-1)!;
      if (last.role === "tool")
        return completion(fork ? "Background turn complete" : "Main notified");
      if (!fork)
        return completion("", {
          name: "send_message",
          input: { text: "Main received a private result" },
        });
      if (JSON.stringify(last.content).includes("INITIAL_WORK"))
        return completion("", {
          name: "bash",
          input: { command: "wait for the test" },
        });
      return completion("", {
        name: "send_message",
        input: { text: "Private followup delivered" },
      });
    },
  );
  const workspaces = new FileSystemWorkspaces(directory);
  const factory = new PiSessionFactory(
    inference,
    workspaces,
    {} as ArtifactWorkbench,
    {
      read: async () => {
        throw new Error("Unexpected file read");
      },
      write: async () => {
        throw new Error("Unexpected file write");
      },
      /** Hold the private session so a second API message must queue behind it. */
      bash: async (id, _input, signal) => {
        assert.equal(id, agentId);
        working = true;
        await new Promise<void>((resolve) => {
          release = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        working = false;
        return {
          output: "PRIVATE_TOOL_OUTPUT",
          signal: null,
          exitCode: 0,
          timedOut: false,
          truncated: false,
        };
      },
    },
    { endpoint: undefined, whenRunning: () => new Promise(() => {}) },
    testApiDocumentation,
  );

  /** Open an HTTP surface over the real conversation coordinator; cold reads must bypass the factory. */
  async function mount(allowOpen = true) {
    const conversations = new ConversationService(
      {
        get: async (ownerId, id) => {
          if (ownerId !== "owner" || ![agentId, otherAgentId].includes(id))
            throw new AgentNotFoundError();
          return { ...definition, id };
        },
        delete: async () => {
          throw new Error("Unexpected main teammate deletion");
        },
      },
      {
        append: async () => {
          throw new Error(
            "Subagent inputs must not enter the visible conversation",
          );
        },
        deliver: async (_scope, text) => {
          const message = {
            id: randomUUID(),
            role: "assistant" as const,
            text,
            createdAt: new Date().toISOString(),
          };
          visible.push(message);
          return message;
        },
        page: async () => ({ messages: visible, nextCursor: null }),
      },
      {
        /** Count runtime opens and explicitly reject them in the disconnected-read phase. */
        create: async (agent, deliver) => {
          assert.ok(
            allowOpen,
            "Reading or deleting history must not open model sessions",
          );
          opened++;
          return factory.create(agent, deliver);
        },
      },
      workspaces,
    );
    services.push(conversations);
    const subagents = new SubagentService(
      conversations,
      new PiSubagentArchives(workspaces),
    );
    const app = Fastify({ ajv: strictRequestValidation });
    app.setErrorHandler(errorHandler);
    await app.register(
      async (scope) => {
        requireAuthentication(scope, {
          /** Model the already-verified app claims and ordinary owner identities at the auth boundary. */
          verify: async (token) => {
            if (token === "owner-app")
              return appIdentity(
                { subject: "service-account" },
                {
                  azp: everythingAppClientId(appId),
                  [everythingAppClaims.app]: appId,
                  [everythingAppClaims.owner]: "owner",
                },
              );
            if (token === "foreign-user") return { subject: "foreign" };
            throw new Error("Invalid token");
          },
        });
        await subagentController(scope, subagents);
      },
      { prefix: "/v1" },
    );
    apps.push(app);
    return { app, conversations };
  }

  const { app, conversations } = await mount();
  const url = `/v1/agents/${agentId}/subagent`;
  const headers = { authorization: "Bearer owner-app" };
  assert.equal((await app.inject(url)).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `${url}/wakeup`,
        payload: { task: "Remote event" },
      })
    ).statusCode,
    401,
  );
  assert.deepEqual((await app.inject({ url, headers })).json(), {
    subagents: [],
  });
  assert.equal(opened, 0);
  const created = await app.inject({
    method: "POST",
    url,
    headers,
    payload: { task: "INITIAL_WORK" },
  });
  assert.equal(created.statusCode, 201);
  const child = created.json() as {
    id: string;
    parentId: string;
    status: string;
  };
  assert.equal(child.parentId, "main");
  await until(() => working);
  assert.equal(visible.length, 0);
  assert.equal(
    (await conversations.status("owner", agentId)).backgroundCount,
    1,
  );
  const messagesUrl = `${url}/${child.id}/messages`;
  const queued = await app.inject({
    method: "POST",
    url: messagesUrl,
    headers,
    payload: { text: "FOLLOWUP" },
  });
  assert.equal(queued.statusCode, 202);
  assert.equal(queued.json().status, "running");
  const before = await app.inject({ url: messagesUrl, headers });
  assert.match(JSON.stringify(before.json()), /INITIAL_WORK/);
  assert.doesNotMatch(JSON.stringify(before.json()), /FOLLOWUP/);
  const opensBeforeUnauthorized = opened;
  for (const request of [
    { method: "GET" as const, url },
    { method: "POST" as const, url, payload: { task: "foreign task" } },
    {
      method: "POST" as const,
      url: `${url}/wakeup`,
      payload: { task: "foreign event" },
    },
    {
      method: "POST" as const,
      url: messagesUrl,
      payload: { text: "foreign message" },
    },
    { method: "GET" as const, url: messagesUrl },
    { method: "DELETE" as const, url: `${url}/${child.id}` },
  ])
    assert.equal(
      (
        await app.inject({
          ...request,
          headers: { authorization: "Bearer foreign-user" },
        })
      ).statusCode,
      404,
    );
  assert.equal(opened, opensBeforeUnauthorized);
  assert.equal(
    (
      await app.inject({
        url: `/v1/agents/${otherAgentId}/subagent/${child.id}/messages`,
        headers,
      })
    ).statusCode,
    404,
  );
  release();
  await until(() => visible.length === 2);
  await until(() => !working);
  const history = (await app.inject({ url: messagesUrl, headers })).json();
  assert.match(JSON.stringify(history), /FOLLOWUP|Private followup delivered/);
  assert.ok(
    history.messages.some(
      (message: ChatMessage) => message.text === "Private followup delivered",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(history),
    /PRIVATE_TOOL_OUTPUT|fixture-key/,
  );
  assert.ok(
    visible.every(
      (message) => message.text === "Main received a private result",
    ),
  );
  const event = await app.inject({
    method: "POST",
    url: `${url}/wakeup`,
    headers,
    payload: { task: "REMOTE_EVENT", context: true },
  });
  assert.equal(event.statusCode, 202);
  const eventId = event.json().id as string;
  assert.notEqual(eventId, child.id);
  await until(() => visible.length === 3);
  // Cleanup follows the final tool-loop completion, independently of the HTTP response.
  let removed = false;
  for (let attempt = 0; attempt < 100 && !removed; attempt++) {
    removed =
      (await app.inject({ url: `${url}/${eventId}/messages`, headers }))
        .statusCode === 404;
    if (!removed) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(
    removed,
    "The temporary transcript must be deleted after the tool loop finishes",
  );
  assert.deepEqual(
    (await app.inject({ url, headers }))
      .json()
      .subagents.map((item: { id: string }) => item.id),
    [child.id],
  );
  const rootId = (await conversations.status("owner", agentId)).sessionId!;
  assert.equal(
    (
      await readdir(
        path.join(workspaces.directory(agentId), ".pi", "forks", rootId),
      )
    ).length,
    1,
  );
  await conversations.close();

  const cold = await mount(false);
  const requestsBeforeRead = requests;
  assert.equal(
    (await cold.app.inject({ url, headers })).json().subagents[0].status,
    "stopped",
  );
  assert.deepEqual(
    (await cold.app.inject({ url: messagesUrl, headers })).json(),
    history,
  );
  assert.equal(requests, requestsBeforeRead);
  const resumed = await mount();
  assert.equal(
    (
      await resumed.app.inject({
        method: "POST",
        url: messagesUrl,
        headers,
        payload: { text: "RESUMED" },
      })
    ).statusCode,
    202,
  );
  await until(() => visible.length === 4);
  await resumed.conversations.close();
  assert.equal(
    (
      await cold.app.inject({
        method: "DELETE",
        url: `${url}/${child.id}`,
        headers,
      })
    ).statusCode,
    204,
  );
  assert.deepEqual((await cold.app.inject({ url, headers })).json(), {
    subagents: [],
  });
  assert.equal(
    (await cold.app.inject({ url: messagesUrl, headers })).statusCode,
    404,
  );
});
