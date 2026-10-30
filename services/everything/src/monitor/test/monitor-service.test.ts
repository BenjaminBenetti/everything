import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import { ServiceShuttingDownError } from "../../conversation/error/conversation-errors.js";
import { ConversationService } from "../../conversation/service/conversation-service.js";
import { ForkLimitError } from "../../runtime/error/fork-errors.js";
import { ProviderUnavailableError } from "../../runtime/error/runtime-errors.js";
import { HttpWorkspaceMonitors } from "../../workspace/adapter/http-workspace-monitors.js";
import type {
  MonitorDeliveryFailure,
  MonitorScope,
  MonitorWakeups,
} from "../interface/monitor-operations.js";
import { MonitorService } from "../service/monitor-service.js";
import { monitorPodFixture } from "./monitor-pod-fixture.js";

const scope: MonitorScope = {
  ownerId: "owner",
  agentId: "00000000-0000-4000-8000-000000000001",
};

/** One recorded wakeup request. */
interface Wakeup {
  readonly scope: MonitorScope;
  readonly task: string;
  readonly context: boolean;
}

/** Follow real fixture processes through the production HTTP transport, with scripted wakeup answers. */
async function fixture(context: TestContext, answers: (() => unknown)[] = []) {
  const directory = await mkdtemp(path.join(tmpdir(), "monitor-service-"));
  const pod = await monitorPodFixture(directory);
  const attempts: Wakeup[] = [];
  const accepted: Wakeup[] = [];
  const failures: MonitorDeliveryFailure[] = [];
  const wakeups: MonitorWakeups = {
    /** Throw the next scripted refusal, otherwise accept the event. */
    wakeup: async (target, input) => {
      const wakeup = { scope: target, ...input };
      attempts.push(wakeup);
      const answer = answers.shift();
      if (answer) answer();
      accepted.push(wakeup);
      return { id: "temporary", parentId: "main", status: "running" };
    },
  };
  const monitors = new MonitorService(
    new HttpWorkspaceMonitors(
      "everything",
      Buffer.alloc(32, 1).toString("base64"),
      pod.fetcher,
    ),
    wakeups,
    (failure) => failures.push(failure),
    {
      unreachableMs: 300,
      waitRetryMs: 20,
      retries: 3,
      minRetryMs: 10,
      maxRetryMs: 20,
    },
  );
  context.after(async () => {
    await monitors.close();
    await pod.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, pod, monitors, attempts, accepted, failures };
}

/** Wait for asynchronous delivery with a bounded deadline. */
async function until(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "The monitor did not settle");
    await delay(10);
  }
}

/** Report whether a fixture file exists. */
function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

test("monitors return before their command finishes and deliver one fresh-context event to the starting teammate", async (context) => {
  const { directory, pod, monitors, accepted } = await fixture(context);
  const started = await monitors.start(scope, "main", {
    command:
      "touch started; while [ ! -f release ]; do sleep 0.02; done; echo 'built ```weird``` output'; echo failure >&2; exit 2",
    instructions: "Tell the user whether the build passed.",
  });
  assert.equal(started.origin, "main");
  assert.equal(started.timeoutSeconds, 3600);
  await until(() => exists(path.join(directory, "started")));
  assert.equal(pod.running(started.id), true);
  assert.deepEqual(
    monitors.list(scope).map(({ id }) => id),
    [started.id],
  );
  // Several wait requests pass without an event while the command runs.
  await delay(450);
  assert.equal(accepted.length, 0);
  assert.ok(
    pod.requests.filter((route) => route.endsWith("/wait")).length >= 2,
  );
  await writeFile(path.join(directory, "release"), "go");
  await until(() => accepted.length === 1);
  const [event] = accepted;
  assert.deepEqual(event!.scope, scope);
  assert.equal(event!.context, false);
  assert.match(event!.task, new RegExp(`Monitor: ${started.id}`));
  assert.match(event!.task, /Started by: main/);
  assert.match(event!.task, /Failed with exit code 2\./);
  assert.match(event!.task, /Tell the user whether the build passed\./);
  assert.match(event!.task, /````\nbuilt ```weird``` output\nfailure\n\n````/);
  await delay(200);
  assert.equal(accepted.length, 1, "Each completion is delivered once");
  assert.deepEqual(monitors.list(scope), []);
});

test("refusals before acceptance are retried with backoff, but accepted, final, and ambiguous attempts are not", async (context) => {
  const { monitors, attempts, accepted } = await fixture(context, [
    () => {
      throw new ForkLimitError();
    },
    () => {
      throw new ProviderUnavailableError();
    },
  ]);
  await monitors.start(scope, "main", { command: "echo first" });
  await until(() => accepted.length === 1);
  assert.equal(attempts.length, 3);
  await delay(100);
  assert.equal(attempts.length, 3, "An accepted event is never resent");

  for (const refusal of [
    () => {
      throw new AgentNotFoundError();
    },
    () => {
      throw new ServiceShuttingDownError();
    },
    () => {
      throw new Error("connection reset after sending");
    },
  ]) {
    const local = await fixture(context, [refusal]);
    await local.monitors.start(scope, "main", { command: "true" });
    await until(() => local.failures.length === 1);
    assert.equal(local.attempts.length, 1);
    assert.equal(local.accepted.length, 0);
    await delay(100);
    assert.equal(
      local.attempts.length,
      1,
      "Final and ambiguous failures are not retried",
    );
  }
  const exhausted = await fixture(
    context,
    Array.from({ length: 4 }, () => () => {
      throw new ForkLimitError();
    }),
  );
  await exhausted.monitors.start(scope, "main", { command: "true" });
  await until(() => exhausted.failures.length === 1);
  assert.equal(exhausted.attempts.length, 4);
  assert.deepEqual(exhausted.failures[0]!.code, "FORK_LIMIT");
});

test("other teammates and owners cannot list or stop a monitor, and stopping returns the outcome without an event", async (context) => {
  const { directory, pod, monitors, accepted } = await fixture(context);
  const started = await monitors.start(scope, "fork-1", {
    command: "touch started; sleep 20",
  });
  await until(() => exists(path.join(directory, "started")));
  for (const other of [
    { ...scope, ownerId: "someone-else" },
    { ...scope, agentId: "00000000-0000-4000-8000-000000000002" },
  ]) {
    assert.deepEqual(monitors.list(other), []);
    await assert.rejects(monitors.stop(other, started.id), {
      code: "MONITOR_NOT_FOUND",
    });
  }
  assert.equal(pod.running(started.id), true);
  const stopped = await monitors.stop(scope, started.id);
  assert.equal(stopped.status, "cancelled");
  assert.equal(pod.running(started.id), false);
  await assert.rejects(monitors.stop(scope, started.id), {
    code: "MONITOR_NOT_FOUND",
  });
  await delay(300);
  assert.equal(accepted.length, 0);
});

test("lost pods are reported as unknown outcomes, and Stop, deletion, and shutdown end commands silently", async (context) => {
  const { directory, pod, monitors, accepted } = await fixture(context);
  const restarted = await monitors.start(scope, "main", {
    command: "touch restarted; sleep 20",
  });
  await until(() => exists(path.join(directory, "restarted")));
  pod.restart();
  await until(() => accepted.length === 1);
  assert.match(
    accepted[0]!.task,
    /Result unknown\. The teammate's workspace no longer has this monitor/,
  );
  assert.match(accepted[0]!.task, new RegExp(restarted.id));
  assert.doesNotMatch(accepted[0]!.task, /\nOutput:\n/);

  const unreachable = await monitors.start(scope, "main", {
    command: "sleep 20",
  });
  pod.failWaits(1000);
  await until(() => accepted.length === 2);
  assert.match(accepted[1]!.task, /stopped responding/);
  assert.match(accepted[1]!.task, new RegExp(unreachable.id));
  pod.failWaits(0);

  const recovering = await monitors.start(scope, "main", {
    command: "sleep 0.3; echo recovered",
  });
  pod.failWaits(2);
  await until(() => accepted.length === 3);
  assert.match(accepted[2]!.task, /recovered/);
  assert.match(accepted[2]!.task, new RegExp(recovering.id));

  const stopped = await monitors.start(scope, "main", { command: "sleep 20" });
  const other = await monitors.start(
    { ...scope, agentId: "00000000-0000-4000-8000-000000000002" },
    "main",
    { command: "sleep 20" },
  );
  await monitors.stopAgent(scope.agentId);
  assert.equal(pod.running(stopped.id), false);
  assert.equal(pod.running(other.id), true);
  await monitors.close();
  assert.equal(pod.running(other.id), false);
  await assert.rejects(monitors.start(scope, "main", { command: "true" }), {
    code: "MONITORS_UNAVAILABLE",
  });
  await delay(300);
  assert.equal(accepted.length, 3);
});

test("a start that races the teammate's Stop is stopped, and a failed stop request keeps the completion event", async (context) => {
  const { directory, pod, monitors, accepted } = await fixture(context);
  const racing = monitors.start(scope, "main", {
    command: "touch raced; sleep 20",
  });
  await monitors.stopAgent(scope.agentId);
  await assert.rejects(racing, { code: "MONITOR_STOPPED" });
  assert.equal(pod.anyRunning(), false);
  assert.deepEqual(monitors.list(scope), []);

  const kept = await monitors.start(scope, "main", {
    command:
      "touch kept; while [ ! -f release ]; do sleep 0.02; done; echo KEPT",
  });
  await until(() => exists(path.join(directory, "kept")));
  pod.failCancels(1);
  await assert.rejects(monitors.stop(scope, kept.id), {
    code: "WORKSPACE_UNAVAILABLE",
  });
  await writeFile(path.join(directory, "release"), "go");
  await until(() => accepted.length === 1);
  assert.match(accepted[0]!.task, /KEPT/);
});

test("a stop request that fails after the command finished still delivers the completion event", async (context) => {
  const { directory, pod, monitors, accepted } = await fixture(context);
  const started = await monitors.start(scope, "main", {
    command:
      "touch started; while [ ! -f release ]; do sleep 0.02; done; echo FINISHED",
  });
  await until(() => exists(path.join(directory, "started")));
  const release = pod.holdCancel();
  const stopping = monitors.stop(scope, started.id);
  await writeFile(path.join(directory, "release"), "go");
  // Following observes the finished command while the stop request is still pending.
  await until(() => pod.terminalWaits() > 0);
  await delay(50);
  assert.equal(accepted.length, 0);
  release(true);
  await assert.rejects(stopping, { code: "WORKSPACE_UNAVAILABLE" });
  await until(() => accepted.length === 1);
  assert.match(accepted[0]!.task, /FINISHED/);
  await delay(100);
  assert.equal(accepted.length, 1);
});

test("a stop request that succeeds after the command finished returns the outcome without an event", async (context) => {
  const { directory, pod, monitors, accepted } = await fixture(context);
  const started = await monitors.start(scope, "main", {
    command:
      "touch started; while [ ! -f release ]; do sleep 0.02; done; echo FINISHED",
  });
  await until(() => exists(path.join(directory, "started")));
  const release = pod.holdCancel();
  const stopping = monitors.stop(scope, started.id);
  // A second stop shares the pending request instead of racing it.
  const repeated = monitors.stop(scope, started.id);
  await writeFile(path.join(directory, "release"), "go");
  await until(() => pod.terminalWaits() > 0);
  release(false);
  const [stopped, again] = await Promise.all([stopping, repeated]);
  assert.equal(stopped.status, "exited");
  assert.match(stopped.output, /FINISHED/);
  assert.deepEqual(again, stopped);
  await delay(200);
  assert.equal(accepted.length, 0);
  assert.deepEqual(monitors.list(scope), []);
});

test("a monitor started while the teammate's Stop is still cancelling another is refused without reaching the pod", async (context) => {
  const { directory, pod, monitors, accepted } = await fixture(context);
  const first = await monitors.start(scope, "main", {
    command: "touch first; sleep 20",
  });
  await until(() => exists(path.join(directory, "first")));
  const release = pod.holdCancel();
  const stopping = monitors.stopAgent(scope.agentId);
  await until(() => pod.requests.includes(`/monitors/${first.id}/cancel`));
  const starts = pod.requests.filter((route) => route === "/monitors").length;
  await assert.rejects(
    monitors.start(scope, "main", { command: "touch second; sleep 20" }),
    { code: "MONITOR_STOPPED" },
  );
  assert.equal(
    pod.requests.filter((route) => route === "/monitors").length,
    starts,
  );
  // Another teammate's monitors are unaffected by this teammate's Stop.
  const other = await monitors.start(
    { ...scope, agentId: "00000000-0000-4000-8000-000000000002" },
    "main",
    { command: "sleep 20" },
  );
  release(false);
  await stopping;
  assert.equal(pod.running(first.id), false);
  assert.equal(pod.running(other.id), true);
  assert.equal(await exists(path.join(directory, "second")), false);
  assert.deepEqual(monitors.list(scope), []);
  await delay(300);
  assert.equal(accepted.length, 0);

  // Once Stop has finished, the teammate can start monitors again.
  await monitors.start(scope, "main", { command: "echo AFTER" });
  await until(() => accepted.length === 1);
  assert.match(accepted[0]!.task, /AFTER/);
});

test("starts are refused until Stop's runtime work settles, and a start in flight before Stop is stopped when it returns", async (context) => {
  const { directory, pod, monitors, accepted } = await fixture(context);
  const releaseStart = pod.holdStart();
  const inFlight = monitors.start(scope, "main", {
    command: "touch in-flight; sleep 20",
  });
  await until(() => pod.requests.includes("/monitors"));
  let finishRuntime!: () => void;
  const runtimeStopped = new Promise<void>(
    (resolve) => (finishRuntime = resolve),
  );
  let settled = false;
  const stopping = monitors
    .stopAgent(scope.agentId, () => runtimeStopped)
    .then(() => (settled = true));
  // Every monitor is already cancelled, but the runtime is still stopping its tools.
  await delay(50);
  assert.equal(settled, false);
  await assert.rejects(
    monitors.start(scope, "main", { command: "touch during; sleep 20" }),
    { code: "MONITOR_STOPPED" },
  );
  finishRuntime();
  await stopping;
  // The pod starts the earlier command only after Stop has finished.
  releaseStart();
  await assert.rejects(inFlight, { code: "MONITOR_STOPPED" });
  assert.equal(await exists(path.join(directory, "during")), false);
  assert.equal(pod.anyRunning(), false);
  assert.deepEqual(monitors.list(scope), []);
  await delay(300);
  assert.equal(accepted.length, 0);
});

test("the user's Stop and deletion refuse monitors the stopping runtime's tools start, but a new user turn keeps them", async (context) => {
  const { pod, monitors, accepted } = await fixture(context);
  const lifecycle: string[] = [];
  const attempts: string[] = [];
  const releases: (() => void)[] = [];
  const definition: AgentDefinition = {
    id: scope.agentId,
    ownerId: scope.ownerId,
    name: "Monitor test teammate",
    systemPrompt: "Watch long commands",
    avatarId: "avatar-01",
    createdAt: "",
    inference: null,
  };
  const conversations = new ConversationService(
    {
      get: async (ownerId, id) => {
        if (ownerId !== scope.ownerId || id !== scope.agentId)
          throw new AgentNotFoundError();
        return definition;
      },
      delete: async () => {
        lifecycle.push("definition-deleted");
      },
    },
    {
      append: async (_scope, role, text) => ({
        id: text,
        role,
        text,
        createdAt: "",
        attachments: [],
      }),
      deliver: async (_scope, text) => ({
        id: text,
        role: "assistant",
        text,
        createdAt: "",
        attachments: [],
      }),
      page: async () => ({ messages: [], nextCursor: null }),
    },
    {
      create: async () => ({
        id: "session",
        compacting: false,
        compactionStartedAt: null,
        lastToolName: undefined,
        typing: false,
        /** Run until stopped, as a turn waiting on a long tool would. */
        prompt: () => new Promise<void>((resolve) => releases.push(resolve)),
        /** A fork's tool call starts a monitor while Stop is still cancelling the existing one. */
        abort: async (stopScope) => {
          if (stopScope === "all") {
            await until(() =>
              pod.requests.some((route) => route.endsWith("/cancel")),
            );
            attempts.push(
              await monitors
                .start(scope, "fork", { command: "touch survivor; sleep 20" })
                .then(
                  () => "started",
                  (error: { code: string }) => error.code,
                ),
            );
          }
          for (const release of releases.splice(0)) release();
        },
        dispose: async () => {
          lifecycle.push("runtime-disposed");
        },
      }),
    },
    {
      remove: async () => {
        lifecycle.push("files-removed");
      },
    },
    monitors,
  );
  context.after(() => conversations.close());

  await conversations.send(scope.ownerId, scope.agentId, { text: "first" });
  const kept = await monitors.start(scope, "main", { command: "sleep 20" });
  await conversations.send(scope.ownerId, scope.agentId, { text: "second" });
  assert.equal(pod.running(kept.id), true, "A new user turn keeps monitors");

  const release = pod.holdCancel();
  const interrupting = conversations.interrupt(scope.ownerId, scope.agentId);
  await until(() => attempts.length === 1);
  release(false);
  await interrupting;
  assert.deepEqual(attempts, ["MONITOR_STOPPED"]);
  assert.equal(pod.anyRunning(), false);
  assert.deepEqual(monitors.list(scope), []);

  await conversations.send(scope.ownerId, scope.agentId, { text: "third" });
  const removed = await monitors.start(scope, "main", { command: "sleep 20" });
  pod.requests.length = 0;
  const releaseDeletion = pod.holdCancel();
  const deleting = conversations.delete(scope.ownerId, scope.agentId);
  await until(() => attempts.length === 2);
  releaseDeletion(false);
  await deleting;
  assert.deepEqual(attempts, ["MONITOR_STOPPED", "MONITOR_STOPPED"]);
  assert.equal(pod.running(removed.id), false);
  assert.equal(pod.anyRunning(), false);
  assert.deepEqual(lifecycle, [
    "runtime-disposed",
    "definition-deleted",
    "files-removed",
  ]);
  await delay(300);
  assert.equal(accepted.length, 0);
});
