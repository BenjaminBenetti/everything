import { testApiDocumentation } from "./api-documentation-fixtures.js";
import { apiDocumentationToolName } from "../../api-documentation/model/api-documentation.js";
import assert from "node:assert/strict";
import type { WorkspaceTools } from "../../workspace/interface/workspace-tools.js";
import { workspaceToolNames } from "../tool/workspace-tools.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { PiSessionFactory } from "../adapter/pi-session-factory.js";
import { stoppedFleet } from "./fleet-mcp-fixtures.js";
import { PiInferenceRuntimeFactory } from "../adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../adapter/pi-model-capabilities.js";
import { createModelRuntime } from "../factory/model-runtime.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
import type { AgentSession } from "../interface/agent-session.js";
import { AgentRuntime } from "../service/agent-runtime.js";
import { appToolNames } from "../tool/app-tools.js";
import { sendMessageToolName } from "../tool/send-message-tool.js";
import { toolSearchToolName } from "../tool/fleet-tools.js";
import { forkToolNames } from "../tool/fork-tools.js";

interface CompletionRequest {
  model: string;
  reasoning_effort?: string;
  tools?: { function: { name: string } }[];
  messages: { role: string; content?: unknown }[];
}

/** Emit genuine Chat Completions SSE, including tool calls and usage consumed by Pi. */
function completion(
  delta: Record<string, unknown>,
  finish: string,
  inputTokens = 100,
): Response {
  const event = {
    id: "completion",
    object: "chat.completion.chunk",
    created: 1,
    model: "o3-mini",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", ...delta },
        finish_reason: finish,
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: 20,
      total_tokens: inputTokens + 20,
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

/** Exercise the native session, tools, summarizer, and persistence with only the provider transport replaced. */
async function fixture(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "everything-chat-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let startSummary!: () => void;
  const summaryStarted = new Promise<void>((resolve) => {
    startSummary = resolve;
  });
  const state = {
    summaries: 0,
    failSummary: false,
    overflow: false,
    overflowed: false,
    pressure: true,
    holdSummary: false,
    summaryStarted,
  };
  const requests: CompletionRequest[] = [];
  const deliveries: string[] = [];
  const capabilities = new PiModelCapabilities(await createModelRuntime());
  const inference = new PiInferenceRuntimeFactory(
    {
      /** Every summary and normal reply must use the same owner's connection. */
      async access(ownerId, provider) {
        assert.equal(ownerId, "owner");
        assert.equal(provider, "openai-compatible");
        return {
          baseUrl: "http://model.test/v1",
          credential: { apiKey: "test-owner-key" },
          model: "o3-mini",
        };
      },
    },
    {
      /** Keep account policy independent from the native runtime fixture. */ async select(
        _ownerId,
        selection,
      ) {
        return { id: selection.model, name: selection.model };
      },
    },
    {
      /** Force a small real context budget so compaction is exercised in a few turns. */
      resolve(provider, id, baseUrl) {
        return {
          ...capabilities.resolve(provider, id, baseUrl),
          contextWindow: 8192,
          maxTokens: 1024,
        };
      },
    },
    async (_input, init) => {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer test-owner-key",
      );
      const body = JSON.parse(String(init?.body)) as CompletionRequest;
      requests.push(body);
      assert.equal(body.model, "o3-mini");
      assert.equal(body.reasoning_effort, "high");
      if (!body.tools?.length) {
        state.summaries++;
        startSummary();
        if (state.holdSummary) {
          await new Promise<void>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) reject(new Error("Aborted"));
            else
              signal?.addEventListener(
                "abort",
                () => reject(new Error("Aborted")),
                { once: true },
              );
          });
        }
        if (state.failSummary)
          return new Response(
            JSON.stringify({ error: { message: "secret-summary-detail" } }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        return completion(
          {
            content:
              "The user’s project is named Kiwi. Keep helping with Kiwi. Previous visible replies were delivered.",
          },
          "stop",
        );
      }
      if (state.overflow && !state.overflowed) {
        state.overflowed = true;
        return new Response(
          JSON.stringify({
            error: {
              message: "maximum context length exceeded",
              code: "context_length_exceeded",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      if (body.messages.at(-1)?.role === "tool")
        return completion(
          { content: "Private completion text." },
          "stop",
          state.pressure ? 7000 : 100,
        );
      return completion(
        {
          tool_calls: [
            {
              index: 0,
              id: `reply-${deliveries.length}`,
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({
                  text: "Hello from your teammate.",
                }),
              },
            },
          ],
        },
        "tool_calls",
      );
    },
  );
  const factory = new PiSessionFactory(
    inference,
    new FileSystemWorkspaces(directory),
    {} as ArtifactWorkbench,
    {} as WorkspaceTools,
    stoppedFleet,
    testApiDocumentation,
  );
  const definition: AgentDefinition = {
    id: "teammate",
    ownerId: "owner",
    name: "Kiwi helper",
    systemPrompt: "Help the user with their project.",
    avatarId: "avatar-01",
    inference: {
      provider: "openai-compatible",
      model: "o3-mini",
      effort: "high",
    },
    createdAt: "",
  };
  const sessions: AgentSession[] = [];
  context.after(async () => {
    for (const session of sessions) {
      await session.abort();
      await session.dispose();
    }
  });
  return {
    state,
    requests,
    deliveries,
    /** Reopen the same teammate directory, just as after a service restart. */
    async open() {
      const session = await factory.create(definition, async (text) => {
        deliveries.push(text);
      });
      sessions.push(session);
      return session;
    },
    /** Inspect persisted checkpoints without assuming a generated transcript filename. */
    async entries() {
      const sessionDirectory = path.join(
        directory,
        "teammate",
        ".pi",
        "sessions",
      );
      const names = (await readdir(sessionDirectory)).filter((name) =>
        name.endsWith(".jsonl"),
      );
      assert.equal(names.length, 1, "one durable session for the teammate");
      return (await readFile(path.join(sessionDirectory, names[0]!), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; summary?: string });
    },
  };
}

test("repeated automatic compaction retains visible replies and reopens the same summarized conversation", async (context) => {
  const f = await fixture(context);
  const session = await f.open();
  const longInput = "The project is Kiwi. " + "project context ".repeat(800);
  await session.prompt(longInput);
  await session.prompt("Keep going. " + longInput);
  await session.prompt("Continue. " + longInput);
  await session.prompt("One more update. " + longInput);
  const checkpoints = (await f.entries()).filter(
    (entry) => entry.type === "compaction",
  );
  assert.ok(
    checkpoints.length >= 2,
    `Expected repeated compaction, got ${checkpoints.length}`,
  );
  assert.deepEqual(f.deliveries, Array(4).fill("Hello from your teammate."));
  assert.ok(
    f.requests
      .filter((request) => !request.tools?.length)
      .some((request) =>
        JSON.stringify(request.messages).includes("previous-summary"),
      ),
  );
  await session.dispose();
  const reopened = await f.open();
  assert.equal(reopened.id, session.id);
  f.state.pressure = false;
  await reopened.prompt("What is the project called?");
  const request = f.requests.filter((item) => item.tools?.length).at(-2)!;
  assert.deepEqual(
    request.tools!.map((tool) => tool.function.name).sort(),
    [
      sendMessageToolName,
      apiDocumentationToolName,
      ...Object.values(appToolNames),
      ...Object.values(workspaceToolNames),
      ...Object.values(forkToolNames),
      toolSearchToolName,
    ].sort(),
    "the reopened chat retains messaging, fork, app, workspace, and tool search tools after compaction",
  );
  assert.ok(
    JSON.stringify(request.messages).includes("Keep helping with Kiwi"),
  );
  assert.equal(f.deliveries.length, 5);
  assert.ok(
    (await f.entries()).filter((entry) => entry.type === "compaction").length >=
      2,
  );
});

test("provider overflow compacts and retries the same turn without duplicating its visible reply", async (context) => {
  const f = await fixture(context);
  f.state.pressure = false;
  const session = await f.open();
  await session.prompt("Earlier context. " + "kiwi ".repeat(2400));
  await session.prompt("More context. " + "kiwi ".repeat(2400));
  f.state.overflow = true;
  await session.prompt("Continue with Kiwi");
  assert.equal(f.state.overflowed, true);
  assert.ok(f.state.summaries > 0);
  assert.equal(f.deliveries.length, 3);
});

test("summary failures surface as safe runtime errors and the same history can recover on a later turn", async (context) => {
  const f = await fixture(context);
  const session = await f.open();
  const runtime = new AgentRuntime(session);
  await session.prompt("Remember Kiwi. " + "kiwi ".repeat(2400));
  f.state.failSummary = true;
  runtime.start("Another Kiwi update. " + "kiwi ".repeat(2400));
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("Runtime did not settle"));
    }, 5000);
    const poll = setInterval(() => {
      if (runtime.status.status !== "running") {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }
    }, 10);
  });
  assert.equal(runtime.status.status, "error");
  assert.ok(!runtime.status.error?.includes("secret-summary-detail"));
  assert.equal(
    (await f.entries()).filter((entry) => entry.type === "compaction").length,
    0,
  );
  f.state.failSummary = false;
  f.state.pressure = false;
  await session.prompt("Try again with Kiwi");
  assert.ok((await f.entries()).some((entry) => entry.type === "compaction"));
  assert.equal(f.deliveries.length, 3);
});

test("stopping an automatic compaction cancels it and allows the next message to proceed", async (context) => {
  const f = await fixture(context);
  const session = await f.open();
  await session.prompt("Remember Kiwi. " + "kiwi ".repeat(2400));
  f.state.holdSummary = true;
  const turn = session.prompt("Another Kiwi update. " + "kiwi ".repeat(2400));
  await f.state.summaryStarted;
  assert.equal(session.compacting, true);
  await session.abort();
  await turn;
  assert.equal(session.compacting, false);
  assert.equal(
    (await f.entries()).filter((entry) => entry.type === "compaction").length,
    0,
  );
  f.state.holdSummary = false;
  f.state.pressure = false;
  await session.prompt("Continue after stopping");
  assert.equal(f.deliveries.length, 3);
});

test("immediate cancellation during prompt setup does not send a late provider request", async (context) => {
  const f = await fixture(context);
  const session = await f.open();
  const turn = session.prompt("Cancel immediately");
  await session.abort();
  await assert.rejects(turn, { name: "AbortError" });
  assert.equal(f.requests.length, 0);
});
