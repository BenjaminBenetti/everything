import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { WorkspaceFiles } from "../../workspace/service/workspace-files.js";
import { LinuxCommandProcessFactory } from "../adapter/linux-command-process-factory.js";
import { BashRunner } from "../service/bash-runner.js";

/** Provide real command supervision in an isolated temporary workspace. */
async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "concurrent-bash-"));
  const bash = new BashRunner(
    new WorkspaceFiles(root),
    new LinuxCommandProcessFactory(),
  );
  context.after(async () => {
    bash.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, bash };
}

/** Wait for commands to reach a file barrier, failing promptly if work is serialized or interrupted. */
async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(
      Date.now() < deadline,
      "Commands did not reach their expected state",
    );
    await delay(10);
  }
}

test("many commands all start before any finishes, retaining independent output and exit status", async (context) => {
  const { bash, root } = await fixture(context);
  const count = 24;
  const pending = Promise.all(
    Array.from({ length: count }, (_, index) =>
      bash.run({
        command: `touch started-${index}; while [ ! -f release ]; do sleep 0.02; done; printf 'result-${index}'; exit ${index % 3}`,
      }),
    ),
  );
  try {
    await until(
      async () =>
        (await readdir(root)).filter((file) => file.startsWith("started-"))
          .length === count,
    );
  } finally {
    await writeFile(path.join(root, "release"), "go");
    const results = await pending;
    for (const [index, result] of results.entries()) {
      assert.equal(result.output, `result-${index}`);
      assert.equal(result.exitCode, index % 3);
      assert.equal(result.signal, null);
      assert.equal(result.timedOut, false);
    }
  }
});

test("completion, cancellation, and timeout clean only their own detached descendants", async (context) => {
  const { bash, root } = await fixture(context);
  const cancellation = new AbortController();
  const survivor = bash.run({
    command:
      "touch survivor-started; while [ ! -f release ]; do sleep 0.02; done; printf survived",
  });
  const cancelled = assert.rejects(
    bash.run(
      {
        command:
          "setsid bash -c 'touch detached-started; sleep 20; echo leaked > cancelled-leak' & wait",
      },
      cancellation.signal,
    ),
    /interrupted/,
  );
  try {
    await until(async () => (await readdir(root)).includes("detached-started"));
    assert.equal(
      (
        await bash.run({
          command:
            "setsid bash -c 'touch completed-started; sleep 0.3; echo leaked > completed-leak' & while [ ! -f completed-started ]; do sleep 0.01; done",
        })
      ).exitCode,
      0,
    );
    cancellation.abort();
    await cancelled;
    const timedOut = await bash.run({
      command: "setsid bash -c 'sleep 20; echo leaked > timeout-leak' & wait",
      timeoutSeconds: 1,
    });
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.signal, "SIGKILL");
    assert.ok((await readdir(root)).includes("survivor-started"));
    for (const name of ["completed-leak", "cancelled-leak", "timeout-leak"])
      await assert.rejects(readFile(path.join(root, name)), { code: "ENOENT" });
  } finally {
    cancellation.abort();
    await cancelled;
    await writeFile(path.join(root, "release"), "go");
    assert.equal((await survivor).output, "survived");
  }
});

test("supervision preserves a command's terminating signal", async (context) => {
  const { bash } = await fixture(context);
  const result = await bash.run({ command: "kill -TERM $$" });
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.timedOut, false);
});

test("closing interrupts every active command and prevents later work", async (context) => {
  const { bash, root } = await fixture(context);
  const pending = Promise.all(
    Array.from({ length: 3 }, (_, index) =>
      assert.rejects(
        bash.run({ command: `touch started-${index}; sleep 20` }),
        /interrupted/,
      ),
    ),
  );
  await until(async () => (await readdir(root)).length === 3);
  bash.close();
  await pending;
  await assert.rejects(bash.run({ command: "true" }), /interrupted/);
});

test("closing during directory resolution prevents process creation", async () => {
  let release!: (directory: string) => void;
  const directory = new Promise<string>((resolve) => {
    release = resolve;
  });
  const bash = new BashRunner(
    {
      /** Hold workspace resolution across shutdown. */
      directory: () => directory,
    },
    {
      /** No command should be launched after shutdown starts. */
      spawn() {
        throw new Error("Unexpected process creation");
      },
    },
  );
  const pending = assert.rejects(bash.run({ command: "true" }), /interrupted/);
  bash.close();
  release("/tmp");
  await pending;
});
