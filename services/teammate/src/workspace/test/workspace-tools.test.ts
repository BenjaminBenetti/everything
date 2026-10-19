import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { workspaceLimits } from "@everything/workspace-contracts";
import { WorkspaceFiles } from "../service/workspace-files.js";
import { BashRunner } from "../../shell/service/bash-runner.js";
import { MonitorRunner } from "../../shell/service/monitor-runner.js";
import { LinuxCommandProcessFactory } from "../../shell/adapter/linux-command-process-factory.js";
import { createHttpApplication } from "../../application/factory/http-application.js";

/**
 * Provide a real temporary workspace beside a shared folder, as `/workspace/<id>` and
 * `/workspace/shared` are, and the same command supervisor as the production API.
 */
async function fixture(context: TestContext) {
  const parent = await mkdtemp(path.join(tmpdir(), "teammate-tools-"));
  const root = path.join(parent, "teammate");
  const shared = path.join(parent, "shared");
  await mkdir(root);
  await mkdir(shared);
  const files = new WorkspaceFiles(root, shared);
  const bash = new BashRunner(files, new LinuxCommandProcessFactory());
  const monitors = new MonitorRunner(files, new LinuxCommandProcessFactory());
  const app = createHttpApplication(files, bash, monitors, "test-token");
  context.after(async () => {
    bash.close();
    await monitors.close();
    await app.close();
    await rm(parent, { recursive: true, force: true });
  });
  return { parent, root, shared, files, bash, app };
}

test("file tools create parents, replace content, and expose bounded continuation reads", async (context) => {
  const { root, files } = await fixture(context);
  assert.deepEqual(
    await files.write({ path: "notes/plan.txt", content: "hello world" }),
    { bytes: 11 },
  );
  assert.deepEqual(await files.read({ path: "notes/plan.txt", limit: 5 }), {
    content: "hello",
    bytes: 5,
    nextOffset: 5,
  });
  assert.deepEqual(await files.read({ path: "notes/plan.txt", offset: 5 }), {
    content: " world",
    bytes: 6,
    nextOffset: null,
  });
  await files.write({ path: "notes/plan.txt", content: "done" });
  assert.equal(
    await readFile(path.join(root, "notes/plan.txt"), "utf8"),
    "done",
  );
  await assert.rejects(
    files.write({
      path: "large",
      content: "é".repeat(workspaceLimits.writeBytes),
    }),
    /1 MiB/,
  );
});

test("files reach the shared folder by its absolute path, also through a link in the workspace", async (context) => {
  const { root, shared, files, bash } = await fixture(context);
  await files.write({
    path: path.join(shared, "handoff/notes.md"),
    content: "for every teammate",
  });
  assert.equal(
    await readFile(path.join(shared, "handoff/notes.md"), "utf8"),
    "for every teammate",
  );
  await symlink(shared, path.join(root, "team"));
  assert.equal(
    (await files.read({ path: "team/handoff/notes.md" })).content,
    "for every teammate",
  );
  assert.equal(
    (await bash.run({ command: "cat handoff/notes.md", cwd: shared })).output,
    "for every teammate",
  );
});

test("files reject traversal, other teammates' workspaces, symlinks leaving the workspace, and private conversation state", async (context) => {
  const { parent, root, files } = await fixture(context);
  await mkdir(path.join(parent, "other-teammate"));
  await writeFile(path.join(parent, "other-teammate/notes"), "theirs");
  await mkdir(path.join(root, ".pi"));
  await writeFile(path.join(root, ".pi/session"), "private");
  await symlink("/etc", path.join(root, "escape"));
  await symlink(path.join(root, ".pi"), path.join(root, "alias"));
  for (const target of [
    "../outside",
    "../other-teammate/notes",
    path.join(parent, "other-teammate/notes"),
    "/etc/passwd",
    ".pi/session",
    "escape/passwd",
    "alias/session",
  ])
    await assert.rejects(files.read({ path: target }), {
      code: "FILE_ACCESS_FAILED",
    });
  await assert.rejects(files.write({ path: "../outside", content: "no" }), {
    code: "FILE_ACCESS_FAILED",
  });
});

test("Bash runs in the workspace with a clean environment and preserves a nonzero exit", async (context) => {
  const { bash, root } = await fixture(context);
  const result = await bash.run({
    command: "printf hello > greeting.txt; printf out; printf err >&2; exit 7",
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.output, "outerr");
  assert.equal(
    await readFile(path.join(root, "greeting.txt"), "utf8"),
    "hello",
  );
  process.env.TEAMMATE_TEST_SECRET = "never inherited";
  context.after(() => {
    delete process.env.TEAMMATE_TEST_SECRET;
  });
  assert.equal(
    (await bash.run({ command: "printf '%s' \"$TEAMMATE_TEST_SECRET\"" }))
      .output,
    "",
  );
});

test("Bash bounds output, times out, cancels promptly, and kills background children", async (context) => {
  const { bash, root } = await fixture(context);
  const result = await bash.run({ command: "head -c 200000 /dev/zero" });
  assert.equal(Buffer.byteLength(result.output), workspaceLimits.outputBytes);
  assert.equal(result.truncated, true);
  const timeout = await bash.run({ command: "sleep 20", timeoutSeconds: 1 });
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.signal, "SIGKILL");
  const cancellation = new AbortController();
  const pending = bash.run({ command: "sleep 20" }, cancellation.signal);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await bash.run({ command: "true" })).exitCode, 0);
  cancellation.abort();
  await assert.rejects(pending, /interrupted/);
  await bash.run({ command: "(sleep 0.3; echo leaked > orphan) &" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await assert.rejects(readFile(path.join(root, "orphan")), { code: "ENOENT" });
});

test("internal API authenticates every operation and validates request schemas", async (context) => {
  const { app } = await fixture(context);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/bash",
        payload: { command: "echo nope" },
      })
    ).statusCode,
    401,
  );
  const headers = { authorization: "Bearer test-token" };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/bash",
        headers,
        payload: { command: "true", timeoutSeconds: 121 },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/files/write",
        headers,
        payload: { path: "one", content: "written", extra: true },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/files/write",
        headers,
        payload: { path: "one", content: "written" },
      })
    ).statusCode,
    200,
  );
  const response = await app.inject({
    method: "POST",
    url: "/files/read",
    headers,
    payload: { path: "one" },
  });
  assert.equal(response.json().content, "written");
});

test("disconnecting a real HTTP caller cancels its running command", async (context) => {
  const { app, root } = await fixture(context);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const cancellation = new AbortController();
  const pending = fetch(`${address}/bash`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command: "echo ready > started; sleep 0.5; echo leaked > finished",
    }),
    signal: cancellation.signal,
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await readFile(path.join(root, "started")).then(
        () => true,
        () => false,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await readFile(path.join(root, "started"), "utf8"), "ready\n");
  const independent = fetch(`${address}/bash`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ command: "sleep 0.2; printf independent" }),
  });
  cancellation.abort();
  await assert.rejects(pending);
  const response = await independent;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).output, "independent");
  await new Promise((resolve) => setTimeout(resolve, 700));
  await assert.rejects(readFile(path.join(root, "finished")), {
    code: "ENOENT",
  });
});
