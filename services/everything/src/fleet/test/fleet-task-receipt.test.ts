import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { taskReceiptProbe } from "../model/fleet-task-receipt.js";

const run = promisify(execFile);
const privileged = process.getuid?.() === 0;

/** Run the probe on `receipt` with POSIX sh, as `fleet shell` runs it in the worker. */
async function probe(
  receipt: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("sh", [
      "-c",
      taskReceiptProbe,
      "sh",
      receipt,
    ]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return failure;
  }
}

/** A folder of receipts that is made searchable again and removed after the test. */
async function receipts(context: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "fleet-receipt-"));
  context.after(async () => {
    await run("chmod", ["-R", "u+rwx", directory]);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("the receipt probe prints a readable receipt, and reports missing only for one that doesn't exist yet", async (context) => {
  const directory = await receipts(context);
  const receipt = path.join(directory, "task", "done.json");
  // Neither the task's folder nor its receipt exists yet.
  assert.deepEqual(await probe(receipt), {
    code: 0,
    stdout: "missing\n",
    stderr: "",
  });
  await mkdir(path.dirname(receipt));
  assert.equal((await probe(receipt)).stdout, "missing\n");
  // A partial receipt is printed as it is, for the monitor to ignore.
  await writeFile(receipt, '{"task":"task","status":"succ');
  assert.deepEqual(await probe(receipt), {
    code: 0,
    stdout: '{"task":"task","status":"succ',
    stderr: "",
  });
  await writeFile(receipt, '{"task":"task","status":"succeeded"}\n');
  assert.equal(
    (await probe(receipt)).stdout,
    '{"task":"task","status":"succeeded"}\n',
  );
});

test("the receipt probe fails with the reason, never missing, for a receipt it can't read", async (context) => {
  const directory = await receipts(context);
  const cases: { name: string; prepare: () => Promise<string> }[] = [
    {
      name: "a folder at the receipt's path",
      prepare: async () => {
        const receipt = path.join(directory, "folder", "done.json");
        await mkdir(receipt, { recursive: true });
        return receipt;
      },
    },
    {
      name: "a file where the task's folder belongs",
      prepare: async () => {
        await writeFile(path.join(directory, "file"), "");
        return path.join(directory, "file", "done.json");
      },
    },
  ];
  // Root reads and searches whatever the permissions say, so these hold only for other accounts.
  if (!privileged)
    cases.push(
      {
        name: "a receipt without read permission",
        prepare: async () => {
          const receipt = path.join(directory, "unreadable", "done.json");
          await mkdir(path.dirname(receipt));
          await writeFile(receipt, '{"task":"unreadable"}');
          await chmod(receipt, 0o000);
          return receipt;
        },
      },
      {
        name: "a task folder that can't be searched",
        prepare: async () => {
          const receipt = path.join(directory, "unsearchable", "done.json");
          await mkdir(path.dirname(receipt));
          await writeFile(receipt, '{"task":"unsearchable"}');
          await chmod(path.dirname(receipt), 0o600);
          return receipt;
        },
      },
    );
  for (const { name, prepare } of cases) {
    const result = await probe(await prepare());
    assert.notEqual(result.code, 0, name);
    assert.doesNotMatch(result.stdout, /missing/, name);
    assert.match(
      result.stderr,
      /Is a directory|Not a directory|Permission denied|cannot search/,
      name,
    );
  }
});
