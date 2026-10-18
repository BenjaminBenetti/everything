import { testConversationSearch } from "../../runtime/test/conversation-search-fixtures.js";
import { testApiDocumentation } from "../../runtime/test/api-documentation-fixtures.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ChatMessage } from "@everything/conversation-contracts";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
import { ConversationService } from "../../conversation/service/conversation-service.js";
import { PiInferenceRuntimeFactory } from "../../runtime/adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";
import { PiSessionFactory } from "../../runtime/adapter/pi-session-factory.js";
import { createModelRuntime } from "../../runtime/factory/model-runtime.js";
import { PiSubagentArchives } from "../../subagent/adapter/pi-subagent-archives.js";
import { SubagentService } from "../../subagent/service/subagent-service.js";
import { HttpWorkspaceMonitors } from "../../workspace/adapter/http-workspace-monitors.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import { MonitorService } from "../service/monitor-service.js";
import { monitorPodFixture } from "./monitor-pod-fixture.js";

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

/** Wait for asynchronous work with a bounded deadline. */
async function until(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "Monitor work did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a teammate's monitor tool returns within the turn and its completion wakes a fresh temporary session that reports to main", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "monitor-api-"));
  const commands = path.join(directory, "commands");
  const pod = await monitorPodFixture(directory);
  const agentId = randomUUID();
  const definition: AgentDefinition = {
    id: agentId,
    ownerId: "owner",
    name: "Monitor test teammate",
    systemPrompt: "Watch long commands",
    avatarId: "avatar-01",
    createdAt: new Date().toISOString(),
    inference: {
      provider: "openai-compatible",
      model: "o3-mini",
      effort: "high",
    },
  };
  const visible: ChatMessage[] = [];
  const forkRequests: { role: string; content?: unknown }[][] = [];
  let toolResult = "";
  const inference = new PiInferenceRuntimeFactory(
    {
      access: async () => ({
        credential: { apiKey: "fixture-key" },
        baseUrl: "http://model.test/v1",
        model: "o3-mini",
      }),
    },
    { select: async () => ({ id: "o3-mini", name: "Test" }) },
    new PiModelCapabilities(await createModelRuntime()),
    async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content?: unknown }[];
      };
      const last = body.messages.at(-1)!;
      const lastText = JSON.stringify(last.content);
      if (String(body.messages[0]!.content).includes("You are private fork ")) {
        forkRequests.push(body.messages);
        return completion("MONITOR_HANDLED exit 4");
      }
      if (last.role === "user" && lastText.includes("RUN_MONITOR"))
        return completion("", {
          name: "monitor",
          input: {
            command: `touch ${commands}-started; while [ ! -f ${commands}-release ]; do sleep 0.02; done; echo MONITOR_DONE; exit 4`,
            instructions: "Report the exit code to the user.",
          },
        });
      if (
        last.role === "tool" &&
        lastText.includes('\\"status\\":\\"running\\"')
      ) {
        toolResult = lastText;
        return completion("", {
          name: "send_message",
          input: { text: "Monitor started" },
        });
      }
      if (last.role === "user" && lastText.includes("finished:"))
        return completion("", {
          name: "send_message",
          input: { text: "Relayed: MONITOR_HANDLED exit 4" },
        });
      return completion("Done.");
    },
  );
  const workspaces = new FileSystemWorkspaces(directory);
  let subagents!: SubagentService;
  const failures: unknown[] = [];
  let holdLookup: Promise<void> | undefined;
  const monitors = new MonitorService(
    new HttpWorkspaceMonitors(
      "everything",
      Buffer.alloc(32, 1).toString("base64"),
      pod.fetcher,
    ),
    {
      wakeup: (scope, input, signal) => subagents.wakeup(scope, input, signal),
    },
    (failure) => failures.push(failure),
  );
  const conversations = new ConversationService(
    {
      get: async (ownerId, id) => {
        if (ownerId !== "owner" || id !== agentId)
          throw new AgentNotFoundError();
        await holdLookup;
        return definition;
      },
      delete: async () => {},
    },
    {
      append: async (_scope, role, text) => ({
        id: randomUUID(),
        role,
        text,
        createdAt: new Date().toISOString(),
      }),
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
    new PiSessionFactory(
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
        bash: async () => {
          throw new Error("Unexpected synchronous Bash");
        },
      },
      { endpoint: undefined, whenRunning: () => new Promise(() => {}) },
      testApiDocumentation,
      testConversationSearch,
      undefined,
      monitors,
    ),
    workspaces,
    monitors,
  );
  subagents = new SubagentService(
    conversations,
    new PiSubagentArchives(workspaces),
  );
  context.after(async () => {
    await monitors.close();
    await conversations.close();
    await pod.close();
    await rm(directory, { recursive: true, force: true });
  });

  await conversations.send("owner", agentId, "RUN_MONITOR");
  // The main turn ends while the command is still waiting for its release file.
  await until(async () => {
    const status = await conversations.status("owner", agentId);
    return toolResult !== "" && status.status === "idle";
  });
  await stat(`${commands}-started`);
  const [running] = monitors.list({ ownerId: "owner", agentId });
  assert.ok(running, "The monitor outlives the turn that started it");
  assert.equal(running.origin, "main");
  assert.equal(pod.running(running.id), true);
  assert.equal(forkRequests.length, 0);

  await writeFile(`${commands}-release`, "go");
  await until(() => visible.length === 2);
  assert.equal(visible[0]!.text, "Monitor started");
  assert.equal(visible[1]!.text, "Relayed: MONITOR_HANDLED exit 4");
  assert.equal(
    forkRequests.length,
    1,
    "One completion creates one temporary session",
  );
  const [system, task, ...rest] = forkRequests[0]!;
  assert.equal(system!.role, "system");
  assert.equal(
    rest.length,
    0,
    "The temporary session starts with fresh context",
  );
  const taskText = JSON.stringify(task!.content);
  assert.doesNotMatch(taskText, /RUN_MONITOR/);
  assert.match(taskText, new RegExp(`Monitor: ${running.id}`));
  assert.match(taskText, /Failed with exit code 4/);
  assert.match(taskText, /MONITOR_DONE/);
  assert.match(taskText, /Report the exit code to the user/);
  assert.deepEqual(monitors.list({ ownerId: "owner", agentId }), []);
  assert.deepEqual(failures, []);

  // The user's Stop action ends a running monitor without a completion event.
  await unlink(`${commands}-release`);
  await conversations.send("owner", agentId, "RUN_MONITOR");
  await until(() => monitors.list({ ownerId: "owner", agentId }).length === 1);
  const [stopped] = monitors.list({ ownerId: "owner", agentId });
  await conversations.interrupt("owner", agentId);
  assert.equal(pod.running(stopped!.id), false);
  assert.deepEqual(monitors.list({ ownerId: "owner", agentId }), []);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(forkRequests.length, 1);
  assert.ok(visible.slice(2).every(({ text }) => text === "Monitor started"));

  // A completion queued behind the user's Stop on the teammate lock is withdrawn, not delivered.
  await conversations.send("owner", agentId, "RUN_MONITOR");
  await until(() => monitors.list({ ownerId: "owner", agentId }).length === 1);
  const shown = visible.length;
  let release!: () => void;
  holdLookup = new Promise((resolve) => {
    release = resolve;
  });
  const interrupted = conversations.interrupt("owner", agentId);
  await writeFile(`${commands}-release`, "go");
  // Let the completion be observed and its wakeup wait for the lock held by Stop.
  await new Promise((resolve) => setTimeout(resolve, 600));
  holdLookup = undefined;
  release();
  await interrupted;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(forkRequests.length, 1);
  assert.equal(visible.length, shown);
  assert.deepEqual(monitors.list({ ownerId: "owner", agentId }), []);
  assert.deepEqual(failures, []);
});
