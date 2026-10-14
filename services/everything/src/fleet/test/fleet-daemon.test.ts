import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { FleetDaemon } from "../service/fleet-daemon.js";

/**
 * A stand-in for `fleet server` that listens on its socket and counts its runs. With
 * `TEST_EXIT_FIRST_RUN`, its first run stops on its own shortly after it starts.
 */
const server = `
const fs = require("node:fs");
const runs = Number(fs.existsSync(process.env.TEST_RUNS) ? fs.readFileSync(process.env.TEST_RUNS, "utf8") : 0) + 1;
fs.writeFileSync(process.env.TEST_RUNS, String(runs));
const listener = require("node:net").createServer().listen(process.env.TEST_SOCKET);
const stop = () => listener.close(() => process.exit(0));
process.on("SIGTERM", stop);
if (runs === 1 && process.env.TEST_EXIT_FIRST_RUN) setTimeout(stop, 200);
`;

/** A daemon running the stand-in, with its socket and run count in a temporary directory. */
async function fixture(
  context: TestContext,
  environment: NodeJS.ProcessEnv = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "fleet-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, "server.cjs");
  const executable = path.join(directory, "fleet");
  await writeFile(script, server);
  await writeFile(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`,
  );
  await chmod(executable, 0o755);
  const runs = path.join(directory, "runs");
  const socket = path.join(directory, "fleet.sock");
  const failures: unknown[] = [];
  const daemon = new FleetDaemon(
    executable,
    { ...environment, TEST_RUNS: runs, TEST_SOCKET: socket },
    socket,
    (error) => failures.push(error),
  );
  context.after(() => daemon.close());
  return {
    daemon,
    failures,
    /** How many times the stand-in has started. */
    runCount: async () => Number(await readFile(runs, "utf8")),
  };
}

test("starts fleetd and stops it with Everything", async (context) => {
  const { daemon, failures, runCount } = await fixture(context);
  await daemon.start();
  assert.equal(await runCount(), 1);
  await daemon.close();
  await assert.rejects(daemon.start());
  assert.deepEqual(failures, []);
});

test("restarts fleetd after it exits on its own and reports the exit", async (context) => {
  const { daemon, failures, runCount } = await fixture(context, {
    TEST_EXIT_FIRST_RUN: "1",
  });
  await daemon.start();
  const deadline = Date.now() + 10_000;
  while ((await runCount()) < 2 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  await daemon.start();
  assert.equal(await runCount(), 2);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /exited with code 0/);
});
