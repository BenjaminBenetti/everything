import { testApiDocumentation } from "./api-documentation-fixtures.js";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
import type { WorkspaceTools } from "../../workspace/interface/workspace-tools.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import { PiInferenceRuntimeFactory } from "../adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../adapter/pi-model-capabilities.js";
import { PiSessionFactory } from "../adapter/pi-session-factory.js";
import { createModelRuntime } from "../factory/model-runtime.js";
import { stoppedFleet } from "./fleet-mcp-fixtures.js";
import type { AgentSession } from "../interface/agent-session.js";

interface CompletionRequest {
  model: string;
  reasoning_effort: string;
  tools: { function: { name: string } }[];
  messages: {
    role: string;
    content?: unknown;
    tool_call_id?: string;
    tool_calls?: { id: string; function: { name: string } }[];
  }[];
}

/** Emit one native provider response so the test exercises Pi's real model and tool loop. */
function completion(
  text: string,
  tool?: { name: string; input: unknown },
): Response {
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: `call-${tool.name}-${Math.random()}`,
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
    `data: ${JSON.stringify({
      id: "completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "o3-mini",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", ...delta },
          finish_reason: tool ? "tool_calls" : "stop",
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Wait for a specified observable transition, failing instead of hanging on a lost background message. */
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(
      Date.now() < deadline,
      "Background work did not reach its expected state",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Check the provider's strict requirement that every copied call is followed by its result. */
function assertValidHistory(request: CompletionRequest): void {
  const pending = new Set<string>();
  for (const message of request.messages) {
    if (message.role === "tool") {
      assert.ok(
        pending.delete(message.tool_call_id!),
        "unexpected or duplicate tool result",
      );
    } else {
      assert.equal(
        pending.size,
        0,
        "a copied tool call has no matching result",
      );
      for (const call of message.tool_calls ?? []) pending.add(call.id);
    }
  }
  assert.equal(pending.size, 0);
}

for (const copyContext of [undefined, false, true]) {
  test(`real Pi forks with context=${String(copyContext)} share settings, exchange messages, and reopen privately`, async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), "everything-forks-"));
    const sessions: AgentSession[] = [];
    context.after(async () => {
      for (const session of sessions) {
        await session.abort();
        await session.dispose();
      }
      await rm(directory, { recursive: true, force: true });
    });
    const requests: { fork: boolean; body: CompletionRequest }[] = [];
    const deliveries: string[] = [];
    let forkId = "";
    let mainRequests = 0;
    let childRequests = 0;
    let releaseWork!: () => void;
    let working = false;
    let commandAborted = false;
    let expectedModel = "o3-mini";
    let expectedEffort = "high";
    const mainSteps: (() => Response)[] = [
      () =>
        completion("", {
          name: "fork",
          input: {
            task: "Do the background work",
            ...(copyContext === undefined ? {} : { context: copyContext }),
          },
        }),
      () =>
        completion("", {
          name: "send_message",
          input: { text: "Started background work" },
        }),
      () => completion("Main is free"),
      () =>
        completion("", {
          name: "send_fork_message",
          input: { recipient: forkId, text: "FOLLOWUP_MARKER" },
        }),
      () =>
        completion("", {
          name: "send_message",
          input: { text: "Answered your next question" },
        }),
      () => completion("Main is free again"),
      () =>
        completion("", {
          name: "send_message",
          input: { text: "Main report one" },
        }),
      () => completion("Reported"),
      () =>
        completion("", {
          name: "send_message",
          input: { text: "Main report two" },
        }),
      () => completion("Reported"),
      () => completion("", { name: "list_forks", input: {} }),
      () =>
        completion("", {
          name: "send_fork_message",
          input: { recipient: forkId, text: "RESUME_MARKER" },
        }),
      () =>
        completion("", {
          name: "send_message",
          input: { text: "Resuming saved fork" },
        }),
      () => completion("Main is free after reload"),
      () =>
        completion("", {
          name: "send_message",
          input: { text: "Restored result received" },
        }),
      () => completion("Reported restored result"),
    ];
    const childSteps: (() => Response)[] = [
      () =>
        completion("", {
          name: "bash",
          input: { command: "work in shared workspace" },
        }),
      () => completion("Initial work complete"),
      () =>
        completion("", {
          name: "send_message",
          input: { text: "Private followup complete" },
        }),
      () => completion("Private final text already delivered"),
      () => completion("Restored work complete"),
    ];
    const inference = new PiInferenceRuntimeFactory(
      {
        /** Check that every main and fork request retains the same owner and connection. */
        async access(ownerId, provider) {
          assert.equal(ownerId, "owner");
          assert.equal(provider, "openai-compatible");
          return {
            credential: { apiKey: "owner-test-key" },
            baseUrl: "http://model.test/v1",
            model: "o3-mini",
          };
        },
      },
      {
        /** Keep model selection deterministic while exercising the real runtime. */
        async select(_ownerId, selection) {
          return { id: selection.model, name: selection.model };
        },
      },
      new PiModelCapabilities(await createModelRuntime()),
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as CompletionRequest;
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer owner-test-key",
        );
        assert.equal(body.model, expectedModel);
        assert.equal(body.reasoning_effort, expectedEffort);
        assertValidHistory(body);
        const system = String(body.messages[0]!.content);
        assert.match(system, /SAVED_INSTRUCTIONS/);
        assert.ok(
          system.includes(`<cwd>\n${path.join(directory, "teammate")}\n</cwd>`),
        );
        const match = system.match(
          /You are private fork ([^,]+), started by main/,
        );
        const fork = Boolean(match);
        if (match) forkId = match[1]!;
        requests.push({ fork, body });
        const step = fork
          ? childSteps[childRequests++]
          : mainSteps[mainRequests++];
        assert.ok(step, `Unexpected ${fork ? "fork" : "main"} request`);
        return step();
      },
    );
    const factory = new PiSessionFactory(
      inference,
      new FileSystemWorkspaces(directory),
      {} as ArtifactWorkbench,
      {
        /** The scripted work should not read files. */
        async read() {
          throw new Error("Unexpected read");
        },
        /** The scripted work should not write files. */
        async write() {
          throw new Error("Unexpected write");
        },
        /** Hold background work across a new user turn and ensure tools use the original teammate's pod. */
        async bash(agentId, _input, signal) {
          assert.equal(agentId, "teammate");
          working = true;
          await new Promise<void>((resolve) => {
            releaseWork = resolve;
            signal?.addEventListener(
              "abort",
              () => {
                commandAborted = true;
                resolve();
              },
              { once: true },
            );
          });
          working = false;
          return {
            output: "CHILD_PRIVATE_OUTPUT",
            signal: null,
            exitCode: 0,
            timedOut: false,
            truncated: false,
          };
        },
      } satisfies WorkspaceTools,
      stoppedFleet,
      testApiDocumentation,
    );
    const definition: AgentDefinition = {
      id: "teammate",
      ownerId: "owner",
      name: "Helper",
      systemPrompt: "SAVED_INSTRUCTIONS",
      avatarId: "avatar-01",
      createdAt: "",
      inference: {
        provider: "openai-compatible",
        model: "o3-mini",
        effort: "high",
      },
    };
    const session = await factory.create(definition, async (text) => {
      deliveries.push(text);
    });
    sessions.push(session);
    await session.prompt("CONTEXT_MARKER: start work in the background");
    await until(() => working);
    assert.deepEqual(deliveries, ["Started background work"]);
    assert.equal(session.background?.running, true);
    const firstFork = requests.find((request) => request.fork)!.body;
    if (copyContext) {
      assert.match(JSON.stringify(firstFork.messages), /CONTEXT_MARKER/);
    } else {
      assert.doesNotMatch(JSON.stringify(firstFork.messages), /CONTEXT_MARKER/);
      assert.equal(
        firstFork.messages.length,
        2,
        "fresh forks receive only system instructions and their task",
      );
    }
    assert.match(
      JSON.stringify(firstFork.messages.at(-1)),
      /Do the background work/,
    );
    assert.deepEqual(
      firstFork.tools.map((tool) => tool.function.name).sort(),
      requests[0]!.body.tools.map((tool) => tool.function.name).sort(),
    );

    await session.abort("turn");
    await session.prompt("Another user question while the fork works");
    assert.equal(commandAborted, false);
    assert.equal(working, true);
    releaseWork();
    await until(
      () => mainRequests === 10 && session.background?.running === false,
    );
    assert.deepEqual(deliveries, [
      "Started background work",
      "Answered your next question",
      "Main report one",
      "Main report two",
    ]);
    assert.ok(
      requests
        .filter((request) => request.fork)
        .some(({ body }) =>
          JSON.stringify(body.messages).includes("FOLLOWUP_MARKER"),
        ),
    );

    await session.abort();
    await session.dispose();
    expectedModel = "o4-mini";
    expectedEffort = "low";
    const reopened = await factory.create(
      {
        ...definition,
        inference: {
          ...definition.inference!,
          model: expectedModel,
          effort: "low",
        },
      },
      async (text) => {
        deliveries.push(text);
      },
    );
    sessions.push(reopened);
    assert.equal(reopened.id, session.id);
    assert.equal(
      requests.length,
      14,
      "restoring histories does not restart work",
    );
    await reopened.prompt("Resume the saved background fork");
    await until(
      () => mainRequests === 16 && reopened.background?.running === false,
    );
    const listed = requests.filter((request) => !request.fork)[11]!.body;
    assert.match(JSON.stringify(listed.messages.at(-1)), new RegExp(forkId));
    assert.match(JSON.stringify(listed.messages.at(-1)), /stopped/);
    const resumed = requests.filter((request) => request.fork).at(-1)!.body;
    assert.match(JSON.stringify(resumed.messages), /CHILD_PRIVATE_OUTPUT/);
    assert.match(JSON.stringify(resumed.messages.at(-1)), /RESUME_MARKER/);
    assert.deepEqual(deliveries.slice(-2), [
      "Resuming saved fork",
      "Restored result received",
    ]);

    const privateDirectory = path.join(directory, "teammate", ".pi");
    const mainFiles = await readdir(path.join(privateDirectory, "sessions"));
    assert.equal(
      mainFiles.length,
      1,
      "forks never become the main conversation on resume",
    );
    const mainHistory = await readFile(
      path.join(privateDirectory, "sessions", mainFiles[0]!),
      "utf8",
    );
    assert.doesNotMatch(mainHistory, /CHILD_PRIVATE_OUTPUT|owner-test-key/);
    assert.equal(
      (await readdir(path.join(privateDirectory, "forks", session.id))).length,
      1,
    );
  });
}
