import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import {
  monitorLimits,
  type MonitorResult,
} from "@everything/workspace-contracts/monitor";
import { WorkspaceFiles } from "../../workspace/service/workspace-files.js";
import { LinuxCommandProcessFactory } from "../adapter/linux-command-process-factory.js";
import { BashRunner } from "../service/bash-runner.js";
import { MonitorRunner } from "../service/monitor-runner.js";
import {
  defaultMonitorPolicy,
  type MonitorPolicy,
} from "../model/monitor-policy.js";
import type { CommandProcessFactory } from "../interface/command-process-factory.js";
import { createHttpApplication } from "../../application/factory/http-application.js";

/** Provide the production supervisor in an isolated workspace beside a shared folder. */
async function fixture(
  context: TestContext,
  policy: MonitorPolicy = defaultMonitorPolicy,
  processes: CommandProcessFactory = new LinuxCommandProcessFactory(),
) {
  const parent = await mkdtemp(path.join(tmpdir(), "monitor-runner-"));
  const root = path.join(parent, "teammate");
  const shared = path.join(parent, "shared");
  await mkdir(root);
  await mkdir(shared);
  const files = new WorkspaceFiles(root, shared);
  const monitors = new MonitorRunner(files, processes, policy);
  context.after(async () => {
    await monitors.close();
    await rm(parent, { recursive: true, force: true });
  });
  return { root, files, monitors };
}

/** Wait for a file barrier with a bounded deadline. */
async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(
      Date.now() < deadline,
      "The command did not reach its expected state",
    );
    await delay(10);
  }
}

/** Report whether a workspace file exists. */
function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** Repeat waits as Everything does until the command finishes. */
async function settle(
  monitors: MonitorRunner,
  id: string,
): Promise<MonitorResult> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await monitors.wait(id, 200);
    if (result.status !== "running") return result;
  }
  assert.fail("The monitor did not finish");
}

test("monitors return while running, then report nonzero exit, output, and a log in the Bash tool's environment", async (context) => {
  const previous = process.env.WORKSPACE_TOKEN;
  process.env.WORKSPACE_TOKEN = "f".repeat(64);
  context.after(() => {
    if (previous === undefined) delete process.env.WORKSPACE_TOKEN;
    else process.env.WORKSPACE_TOKEN = previous;
  });
  const { root, monitors } = await fixture(context);
  await mkdir(path.join(root, "project"));
  const started = Date.now();
  const running = await monitors.start({
    command:
      'touch started; while [ ! -f release ]; do sleep 0.02; done; printf \'out:%s:%s:%s\\n\' "$PWD" "$HOME" "${WORKSPACE_TOKEN:-unset}"; echo err >&2; exit 3',
    cwd: "project",
  });
  assert.ok(
    Date.now() - started < 2000,
    "Starting must not wait for completion",
  );
  assert.equal(running.status, "running");
  assert.equal(running.finishedAt, null);
  assert.equal(running.log, `.monitors/${running.id}.log`);
  await until(() => exists(path.join(root, "project", "started")));
  assert.equal((await monitors.wait(running.id, 50)).status, "running");
  await writeFile(path.join(root, "project", "release"), "go");
  const result = await settle(monitors, running.id);
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 3);
  assert.equal(result.signal, null);
  assert.equal(result.reason, null);
  assert.equal(
    result.output,
    `out:${path.join(root, "project")}:${root}:unset\nerr\n`,
  );
  assert.equal(result.truncated, false);
  assert.equal(result.outputBytes, Buffer.byteLength(result.output));
  assert.ok(result.finishedAt);
  assert.equal(
    await readFile(path.join(root, result.log), "utf8"),
    result.output,
  );
  assert.equal((await stat(path.join(root, result.log))).mode & 0o777, 0o600);
  // Finished results remain readable for repeated waits.
  assert.deepEqual(await monitors.wait(running.id, 50), result);
});

test("large output keeps a bounded beginning and end without splitting UTF-8, and the log stops at its limit", async (context) => {
  const { root, monitors } = await fixture(context);
  const characters = await monitors.start({
    command:
      "printf x; for i in $(seq 20000); do printf 'é'; done; printf 'END'",
  });
  const text = await settle(monitors, characters.id);
  assert.equal(text.truncated, true);
  assert.equal(text.outputBytes, 1 + 40000 + 3);
  assert.ok(text.output.startsWith("xé"));
  assert.ok(text.output.endsWith("éEND"));
  assert.doesNotMatch(text.output, /�/);
  assert.match(text.output, /\[… \d+ bytes omitted …\]/);
  assert.ok(
    Buffer.byteLength(text.output) <=
      monitorLimits.headBytes + monitorLimits.tailBytes + 64,
  );
  assert.equal(text.logTruncated, false);
  assert.equal(
    (await readFile(path.join(root, text.log), "utf8")).length,
    1 + 20000 + 3,
  );
  const flood = await monitors.start({
    command: `head -c ${monitorLimits.logBytes + 4096} /dev/zero; echo done >&2`,
  });
  const flooded = await settle(monitors, flood.id);
  assert.equal(flooded.exitCode, 0);
  assert.equal(flooded.outputBytes, monitorLimits.logBytes + 4096 + 5);
  assert.equal(flooded.logTruncated, true);
  assert.equal(
    (await stat(path.join(root, flooded.log))).size,
    monitorLimits.logBytes,
  );
  assert.ok(flooded.output.endsWith("done\n"));
});

test("timeouts and stop requests end the command and its detached descendants", async (context) => {
  const { root, monitors } = await fixture(context);
  const timed = await monitors.start({
    command:
      "setsid bash -c 'sleep 1.5; echo leaked > timeout-leak' & echo waiting; wait",
    timeoutSeconds: 1,
  });
  const cancelled = await monitors.start({
    command:
      "setsid bash -c 'touch detached-started; sleep 1.5; echo leaked > cancel-leak' & wait",
  });
  await until(() => exists(path.join(root, "detached-started")));
  const stopped = await monitors.cancel(cancelled.id);
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.reason, "The monitor was stopped on request.");
  const timedOut = await settle(monitors, timed.id);
  assert.equal(timedOut.status, "timed-out");
  assert.equal(timedOut.output, "waiting\n");
  assert.match(timedOut.reason!, /1-second timeout/);
  // Cancelling a finished monitor reports its original outcome.
  assert.equal((await monitors.cancel(timed.id)).status, "timed-out");
  await delay(800);
  for (const name of ["timeout-leak", "cancel-leak"])
    assert.equal(await exists(path.join(root, name)), false);
});

test("commands that cannot start report a failure instead of running", async (context) => {
  const { monitors } = await fixture(context, defaultMonitorPolicy, {
    /** Simulate a missing supervisor binary. */
    spawn: (command, cwd, environment) =>
      spawn("/nonexistent/command-supervisor", [command], {
        cwd,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      }),
  });
  const started = await monitors.start({ command: "true" });
  const result = await settle(monitors, started.id);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "The command could not start.");
  assert.equal(result.exitCode, null);
});

test("unattended commands stop when their lease expires and finished results are later forgotten", async (context) => {
  const { root, monitors } = await fixture(context, {
    leaseMs: 150,
    retentionMs: 800,
    sweepMs: 20,
  });
  const attended = await monitors.start({
    command: "sleep 0.4; echo attended",
  });
  const orphan = await monitors.start({
    command: "touch orphan-started; sleep 5; echo leaked > orphan-leak",
  });
  await until(() => exists(path.join(root, "orphan-started")));
  // Waiting keeps the attended command's lease current while the orphan's expires.
  const result = await settle(monitors, attended.id);
  assert.equal(result.output, "attended\n");
  const expired = await monitors.wait(orphan.id, 0);
  assert.equal(expired.status, "cancelled");
  assert.equal(
    expired.reason,
    "No one was waiting for the result, so the command was stopped.",
  );
  await delay(1000);
  await assert.rejects(monitors.wait(orphan.id, 0), {
    code: "MONITOR_NOT_FOUND",
  });
  await assert.rejects(monitors.cancel(attended.id), {
    code: "MONITOR_NOT_FOUND",
  });
  assert.equal(await exists(path.join(root, "orphan-leak")), false);
});

test("concurrency is bounded, old logs are pruned, and closing stops everything", async (context) => {
  const { root, monitors } = await fixture(context);
  for (let index = 0; index < monitorLimits.retainedLogs + 3; index++)
    await settle(
      monitors,
      (await monitors.start({ command: `echo ${index}` })).id,
    );
  assert.ok(
    (await readdir(path.join(root, ".monitors"))).length <=
      monitorLimits.retainedLogs,
  );
  const running = await Promise.all(
    Array.from({ length: monitorLimits.concurrent }, (_, index) =>
      monitors.start({ command: `touch running-${index}; sleep 20` }),
    ),
  );
  await assert.rejects(monitors.start({ command: "true" }), {
    code: "MONITOR_LIMIT",
  });
  await until(
    async () =>
      (await readdir(root)).filter((name) => name.startsWith("running-"))
        .length === monitorLimits.concurrent,
  );
  await monitors.close();
  for (const { id } of running) {
    const result = await monitors.wait(id, 0);
    assert.equal(result.status, "cancelled");
    assert.equal(result.reason, "The teammate's workspace stopped.");
  }
  await assert.rejects(monitors.start({ command: "true" }), {
    code: "MONITORS_CLOSED",
  });
});

test("the internal API starts monitors without holding the request, long-polls, cancels, and validates input", async (context) => {
  const { root, files, monitors } = await fixture(context);
  const bash = new BashRunner(files, new LinuxCommandProcessFactory());
  const app = createHttpApplication(files, bash, monitors, "test-token");
  context.after(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const headers = {
    authorization: "Bearer test-token",
    "content-type": "application/json",
  };
  /** Post JSON to the API as Everything does. */
  const post = (route: string, body: unknown = {}, auth = headers) =>
    fetch(`${address}${route}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await post("/monitors", { command: "true" }, {
        "content-type": "application/json",
      } as typeof headers)
    ).status,
    401,
  );
  for (const body of [
    { command: "true", timeoutSeconds: monitorLimits.timeoutSeconds + 1 },
    { command: "true", agentId: "someone-else" },
    { command: "" },
  ])
    assert.equal((await post("/monitors", body)).status, 400);
  assert.equal((await post("/monitors/not-a-uuid/wait")).status, 400);
  assert.equal(
    (await post("/monitors/00000000-0000-4000-8000-000000000000/wait")).status,
    404,
  );
  const response = await post("/monitors", {
    command:
      "touch http-started; while [ ! -f http-release ]; do sleep 0.02; done; echo finished",
  });
  assert.equal(response.status, 200);
  const started = (await response.json()) as MonitorResult;
  assert.equal(started.status, "running");
  // The start request has completed and its connection is gone; the command keeps running.
  await until(() => exists(path.join(root, "http-started")));
  const waiting = post(`/monitors/${started.id}/wait`);
  await delay(100);
  await writeFile(path.join(root, "http-release"), "go");
  const finished = (await (await waiting).json()) as MonitorResult;
  assert.equal(finished.status, "exited");
  assert.equal(finished.output, "finished\n");
  const long = (await (
    await post("/monitors", { command: "sleep 20" })
  ).json()) as MonitorResult;
  const cancelled = (await (
    await post(`/monitors/${long.id}/cancel`)
  ).json()) as MonitorResult;
  assert.equal(cancelled.status, "cancelled");
});
