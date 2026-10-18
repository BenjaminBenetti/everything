import { testConversationSearch } from "../../runtime/test/conversation-search-fixtures.js";
import { testApiDocumentation } from "../../runtime/test/api-documentation-fixtures.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { ChatMessage } from "@everything/conversation-contracts";
import { fleetTokenWorkspaceFile } from "@everything/workspace-contracts/mount";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
import { ConversationService } from "../../conversation/service/conversation-service.js";
import {
  taskReceiptDirectory,
  taskReceiptMonitorScript,
  taskReceiptPlaceholders,
} from "../../fleet/model/fleet-task-receipt.js";
import { PiInferenceRuntimeFactory } from "../../runtime/adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";
import { PiSessionFactory } from "../../runtime/adapter/pi-session-factory.js";
import { createModelRuntime } from "../../runtime/factory/model-runtime.js";
import { PiSubagentArchives } from "../../subagent/adapter/pi-subagent-archives.js";
import { SubagentService } from "../../subagent/service/subagent-service.js";
import { HttpWorkspaceMonitors } from "../../workspace/adapter/http-workspace-monitors.js";
import { HttpWorkspaceTools } from "../../workspace/adapter/http-workspace-tools.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import { MonitorService } from "../service/monitor-service.js";
import {
  eventually,
  fleetStack,
  fleetStackSettings,
} from "./fleet-stack-fixture.js";

const settings = fleetStackSettings();

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

/** The prompt's receipt monitor script for one task, polling every half second. */
function receiptScript(worker: string, task: string): string {
  return taskReceiptMonitorScript
    .replace(taskReceiptPlaceholders.target, worker)
    .replace(taskReceiptPlaceholders.task, task)
    .replace("interval=30", "interval=0.5");
}

/** A shell command that writes `content` as a task's receipt, atomically unless `partial`. */
function writeReceipt(task: string, content: string, partial = false): string {
  const folder = `${taskReceiptDirectory}/${task}`;
  const json = content.replaceAll("'", "'\\''");
  return partial
    ? `mkdir -p ${folder} && printf '%s' '${json}' > ${folder}/done.json`
    : `mkdir -p ${folder} && printf '%s\\n' '${json}' > ${folder}/done.json.tmp && mv ${folder}/done.json.tmp ${folder}/done.json`;
}

test(
  "a teammate's monitor follows a real worker's receipt through the pinned Fleet client, the chart's gateway image, and Everything's fleetd, and its outcome wakes a fresh session",
  {
    skip: settings
      ? false
      : "set FLEET_E2E_BINARY, FLEET_E2E_HOME, FLEET_E2E_WORKER, FLEET_E2E_TEAMMATE_IMAGE and FLEET_E2E_GATEWAY_IMAGE to run the real-process Fleet stack",
    timeout: 15 * 60_000,
  },
  async (context) => {
    const stack = await fleetStack(settings!);
    context.after(() => stack.close());
    const worker = settings!.worker;
    const { agentId } = stack;
    const definition: AgentDefinition = {
      id: agentId,
      ownerId: "owner",
      name: "Fleet monitor teammate",
      systemPrompt: "Delegate to workers",
      avatarId: "avatar-01",
      createdAt: new Date().toISOString(),
      inference: {
        provider: "openai-compatible",
        model: "o3-mini",
        effort: "high",
      },
    };
    const visible: ChatMessage[] = [];
    /** Each wakeup's fresh-context request, by the monitor ID its task names. */
    const wakeups: {
      id: string;
      messages: { role: string; content?: unknown }[];
    }[] = [];
    const started: string[] = [];
    /** Monitor inputs the model sends, in order, one for each RUN_MONITOR message. */
    const pending: Record<string, unknown>[] = [];
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
        if (
          String(body.messages[0]!.content).includes("You are private fork ")
        ) {
          const id = /Monitor: ([0-9a-f-]{36})/.exec(
            JSON.stringify(body.messages[1]!.content),
          )?.[1];
          wakeups.push({ id: id ?? "unknown", messages: body.messages });
          return completion(`HANDLED ${id}`);
        }
        if (last.role === "user" && lastText.includes("RUN_MONITOR"))
          return completion("", { name: "monitor", input: pending.shift() });
        if (
          last.role === "tool" &&
          lastText.includes('\\"status\\":\\"running\\"')
        ) {
          started.push(/\\"id\\":\\"([0-9a-f-]{36})\\"/.exec(lastText)![1]!);
          return completion("", {
            name: "send_message",
            input: { text: "Monitor started" },
          });
        }
        if (last.role === "user" && lastText.includes("finished:"))
          return completion("", {
            name: "send_message",
            input: { text: "Relayed" },
          });
        return completion("Done.");
      },
    );
    const workspaces = new FileSystemWorkspaces(
      path.join(tmpdir(), `fleet-e2e-archives-${agentId}`),
    );
    let subagents!: SubagentService;
    const deliveryFailures: unknown[] = [];
    const monitors = new MonitorService(
      new HttpWorkspaceMonitors("everything", stack.key, stack.fetcher),
      {
        wakeup: (scope, input, signal) =>
          subagents.wakeup(scope, input, signal),
      },
      (failure) => deliveryFailures.push(failure),
    );
    const tools = new HttpWorkspaceTools(
      "everything",
      stack.key,
      stack.fetcher,
    );
    const conversations = new ConversationService(
      {
        get: async (ownerId, id) => {
          if (ownerId !== "owner" || id !== agentId)
            throw new AgentNotFoundError();
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
        tools,
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
    });

    /** Have the teammate start a monitor in a real turn and return its ID once the turn is idle. */
    async function startMonitor(
      input: Record<string, unknown>,
    ): Promise<string> {
      const before = started.length;
      pending.push(input);
      await conversations.send("owner", agentId, "RUN_MONITOR");
      await eventually(async () => {
        const status = await conversations.status("owner", agentId);
        return started.length > before && status.status === "idle";
      }, "the monitor tool returns within the turn");
      return started.at(-1)!;
    }
    /** The fresh-context wakeup task for a monitor, once delivered. */
    async function wakeupTask(
      id: string,
      timeoutMs = 120_000,
    ): Promise<string> {
      await eventually(
        () => wakeups.some((wakeup) => wakeup.id === id),
        `monitor ${id} wakes a session`,
        timeoutMs,
      );
      const { messages } = wakeups.find((wakeup) => wakeup.id === id)!;
      assert.equal(messages.length, 2, "the wakeup starts with fresh context");
      return JSON.stringify(messages[1]!.content);
    }
    /** Run a command in the worker through the gateway, as the worker's agent would. */
    async function inWorker(script: string): Promise<void> {
      const result = await stack.client([
        "shell",
        worker,
        "--",
        "sh",
        "-c",
        script,
      ]);
      assert.equal(result.code, 0, result.output);
    }

    // ===========================================
    // Connection: refused until published, then automatic, authenticated, and local-daemon-free
    // ===========================================

    await stack.start();
    const unpublished = await stack.exec("fleet ls");
    assert.equal(unpublished.code, 69);
    assert.match(unpublished.output, /isn't connected to this workspace yet/);
    stack.publish();
    await eventually(
      async () => (await stack.address()) !== "",
      "the address is published",
    );
    const address = await stack.address();
    assert.match(
      address,
      new RegExp(`^${stack.gatewayUrl}/grpc/[0-9a-f]{64}$`),
    );

    const listing = await tools.bash(agentId, {
      command: "fleet ls; echo; env",
    });
    assert.equal(listing.exitCode, 0, listing.output);
    assert.match(listing.output, new RegExp(worker.split("/")[1]!));
    // The token reaches only the fleet process; commands see no Fleet or controller credentials.
    assert.doesNotMatch(
      listing.output,
      /FLEET_TOKEN|FLEET_GATEWAY|WORKSPACE_TOKEN/,
    );
    assert.ok(!listing.output.includes(stack.token));
    const redacted = await tools.bash(agentId, {
      command: `cat ${fleetTokenWorkspaceFile}`,
    });
    assert.equal(redacted.output, "[redacted]");
    // The pinned client: same version as fleetd, which a mismatch would refuse.
    const version = await stack.exec("/usr/local/libexec/fleet/fleet version");
    assert.match(version.output, /v3\.2\.0-beta/);
    const wrongToken = await stack.exec(
      `FLEET_TOKEN=${"0".repeat(64)} fleet ls`,
    );
    assert.equal(wrongToken.code, 1);
    assert.match(wrongToken.output, /Unauthenticated/);
    assert.ok(!wrongToken.output.includes(stack.token));
    if (settings!.otherClient) {
      const mismatch = await stack.client(["ls"], {}, settings!.otherClient);
      assert.notEqual(mismatch.code, 0);
      assert.match(mismatch.output, /server is v3\.2\.0-beta but client is v/);
    }
    // `fleet exec` resolves the worker's command but runs it on the caller, which cannot.
    const local = await stack.exec(`fleet exec ${worker} -- hostname`);
    assert.notEqual(local.code, 0);
    const remote = await stack.exec(`fleet shell ${worker} -- hostname`);
    assert.equal(remote.code, 0, remote.output);
    assert.notEqual(
      remote.output.trim(),
      (await stack.exec("hostname")).output.trim(),
    );

    // ===========================================
    // Success: missing, stale, and partial receipts are ignored until the atomic one arrives
    // ===========================================

    const success = `success-${randomUUID()}`;
    const succeeded = await startMonitor({
      command: receiptScript(worker, success),
      instructions: "Tell the user the worker's summary.",
    });
    await sleep(1_500);
    await inWorker(
      writeReceipt(
        success,
        JSON.stringify({ task: "an-older-task", status: "succeeded" }),
      ),
    );
    await sleep(1_500);
    await inWorker(
      writeReceipt(success, `{"task":"${success}","status":"succ`, true),
    );
    await sleep(1_500);
    assert.equal(
      wakeups.some(({ id }) => id === succeeded),
      false,
    );
    await inWorker(
      writeReceipt(
        success,
        JSON.stringify({
          task: success,
          status: "succeeded",
          exitCode: 0,
          summary: "SUMMARY_SUCCESS",
          report: "/tmp/report.md",
        }),
      ),
    );
    const successTask = await wakeupTask(succeeded);
    assert.match(successTask, /Succeeded with exit code 0/);
    assert.match(successTask, /SUMMARY_SUCCESS/);
    assert.match(successTask, /Ignoring an unfinished or stale receipt/);
    assert.match(successTask, /Tell the user the worker's summary/);

    // ===========================================
    // Failure: a receipt reporting failure ends the monitor with exit 1
    // ===========================================

    const failure = `failure-${randomUUID()}`;
    const failed = await startMonitor({
      command: receiptScript(worker, failure),
    });
    await inWorker(
      writeReceipt(
        failure,
        JSON.stringify({
          task: failure,
          status: "failed",
          exitCode: 3,
          summary: "SUMMARY_FAILED",
        }),
      ),
    );
    const failureTask = await wakeupTask(failed);
    assert.match(failureTask, /Failed with exit code 1/);
    assert.match(failureTask, /SUMMARY_FAILED/);

    // ===========================================
    // Restarts: the gateway and fleetd come back with the same session, so the address holds
    // ===========================================

    const restart = `restart-${randomUUID()}`;
    const restarted = await startMonitor({
      command: receiptScript(worker, restart),
    });
    await sleep(1_500);
    await stack.stopGateway();
    await sleep(2_000);
    await stack.startGateway();
    // fleetd reconnects on its own and the gateway resumes its session from the signed token.
    await eventually(
      async () => (await stack.client(["ls"])).code === 0,
      "fleetd reconnects to the restarted gateway",
    );
    assert.equal(
      await stack.address(),
      address,
      "the gateway kept the session",
    );
    await stack.restartFleetd();
    await eventually(
      async () => (await stack.client(["ls"])).code === 0,
      "the restarted fleetd registers again",
    );
    assert.equal(
      await stack.address(),
      address,
      "the client address is stable",
    );
    await inWorker(
      writeReceipt(
        restart,
        JSON.stringify({
          task: restart,
          status: "succeeded",
          exitCode: 0,
          summary: "SUMMARY_RESTART",
        }),
      ),
    );
    const restartTask = await wakeupTask(restarted);
    assert.match(restartTask, /Succeeded with exit code 0/);
    assert.match(restartTask, /SUMMARY_RESTART/);

    // ===========================================
    // Timeout: the deadline stops the process group and reports what it printed, once
    // ===========================================

    const timeout = `timeout-${randomUUID()}`;
    await inWorker(
      writeReceipt(
        timeout,
        JSON.stringify({ task: "someone-else", status: "succeeded" }),
      ),
    );
    const timedOut = await startMonitor({
      command: receiptScript(worker, timeout),
      timeoutSeconds: 4,
    });
    const timeoutTask = await wakeupTask(timedOut);
    assert.match(timeoutTask, /Timed out and was stopped/);
    assert.match(timeoutTask, /4-second timeout/);
    assert.match(timeoutTask, /Ignoring an unfinished or stale receipt/);
    await sleep(1_500);
    assert.equal(wakeups.filter(({ id }) => id === timedOut).length, 1);
    const leftovers = await stack.exec(
      "pgrep -fa '[f]leet shell|[l]ibexec/fleet' || true",
    );
    assert.equal(leftovers.output.trim(), "");

    // ===========================================
    // Unreachable: probes that keep failing end the monitor with exit 2
    // ===========================================

    await stack.stopGateway();
    const unreachable = `unreachable-${randomUUID()}`;
    const lost = await startMonitor({
      command: receiptScript(worker, unreachable).replace(
        "interval=0.5",
        "interval=0.1",
      ),
    });
    const unreachableTask = await wakeupTask(lost);
    assert.match(unreachableTask, /Failed with exit code 2/);
    assert.match(unreachableTask, /Fleet could not reach/);
    await stack.startGateway();

    // ===========================================
    // Redaction: a monitor that prints the token reports it redacted
    // ===========================================

    const printed = await startMonitor({
      command: `cat ${fleetTokenWorkspaceFile}`,
    });
    const printedTask = await wakeupTask(printed);
    assert.ok(!printedTask.includes(stack.token));
    assert.match(printedTask, /\[redacted\]/);

    // No daemon of its own ever started in the teammate's workspace.
    await assert.rejects(stat(path.join(stack.workspace, ".fleet")), {
      code: "ENOENT",
    });
    assert.deepEqual(deliveryFailures, []);
    assert.deepEqual(stack.failures, []);
    assert.deepEqual(monitors.list({ ownerId: "owner", agentId }), []);
  },
);
