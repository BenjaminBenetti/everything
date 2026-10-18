import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { monitorLimits } from "@everything/workspace-contracts/monitor";
import { WorkspaceFiles } from "../../workspace/service/workspace-files.js";
import { LinuxCommandProcessFactory } from "../adapter/linux-command-process-factory.js";
import { commandEnvironment } from "../model/command-environment.js";
import { defaultMonitorPolicy } from "../model/monitor-policy.js";
import { redactedText, SecretRedactor } from "../model/secret-redactor.js";
import { BashRunner } from "../service/bash-runner.js";
import { MonitorRunner } from "../service/monitor-runner.js";

const token = "0123456789abcdef".repeat(4);

/** Redact `chunks` as one stream and return the text released. */
function redact(chunks: readonly string[], secrets = [token]): string {
  const redactor = new SecretRedactor(secrets);
  return Buffer.concat([
    ...chunks.map((chunk) => redactor.push(Buffer.from(chunk))),
    redactor.end(),
  ]).toString("utf8");
}

/** Real command supervision in an isolated workspace, with the token as a redacted secret. */
async function fixture(context: TestContext) {
  const parent = await mkdtemp(path.join(tmpdir(), "redaction-"));
  const root = path.join(parent, "teammate");
  const shared = path.join(parent, "shared");
  await mkdir(root);
  await mkdir(shared);
  const files = new WorkspaceFiles(root, shared);
  const processes = new LinuxCommandProcessFactory();
  const environment = {
    ...commandEnvironment(process.env, root),
    SECRET: token,
  };
  const bash = new BashRunner(files, processes, environment, [token]);
  const monitors = new MonitorRunner(
    files,
    processes,
    defaultMonitorPolicy,
    environment,
    Date.now,
    [token],
  );
  context.after(async () => {
    bash.close();
    await monitors.close();
    await rm(parent, { recursive: true, force: true });
  });
  return { root, bash, monitors };
}

test("redacts every occurrence of a secret, including one split across chunks at any point", () => {
  assert.equal(
    redact([`a${token}b${token}`]),
    `a${redactedText}b${redactedText}`,
  );
  for (let cut = 1; cut < token.length; cut++)
    assert.equal(
      redact([`before ${token.slice(0, cut)}`, `${token.slice(cut)} after`]),
      `before ${redactedText} after`,
    );
  // One byte per chunk still finds it.
  assert.equal(redact([...`x${token}y`]), `x${redactedText}y`);
  // A beginning that never completes is released unchanged at the end.
  assert.equal(
    redact(["ends with ", token.slice(0, 20)]),
    `ends with ${token.slice(0, 20)}`,
  );
  // Output without secrets passes through as is.
  assert.equal(redact(["plain"], []), "plain");
  assert.equal(redact(["short"], ["short"]), "short");
});

test("releases output that cannot begin a secret at once, holding back only a possible beginning", () => {
  const redactor = new SecretRedactor([token]);
  assert.equal(
    redactor.push(Buffer.from("progress 1\n")).toString(),
    "progress 1\n",
  );
  assert.equal(
    redactor.push(Buffer.from(`next ${token.slice(0, 5)}`)).toString(),
    "next ",
  );
  assert.equal(
    redactor.push(Buffer.from("zzz")).toString(),
    `${token.slice(0, 5)}zzz`,
  );
});

test("Bash output never returns the Fleet token, whichever stream or chunk carries it", async (context) => {
  const { bash } = await fixture(context);
  const result = await bash.run({
    command:
      'printf "%s\\n" "$SECRET"; printf "%s" "$SECRET" >&2; printf "%s" "${SECRET:0:30}"; sleep 0.05; printf "%s\\n" "${SECRET:30}"',
  });
  assert.equal(result.exitCode, 0);
  assert.ok(!result.output.includes(token));
  assert.ok(!result.output.includes(token.slice(0, 30) + token.slice(30)));
  assert.equal(result.output.split(redactedText).length - 1, 3);
});

test("monitor output, its completion snapshot, and its log never contain the Fleet token", async (context) => {
  const { root, monitors } = await fixture(context);
  const started = await monitors.start({
    command: `for i in 1 2 3; do printf "%s" "\${SECRET:0:10}"; sleep 0.02; printf "%s\\n" "\${SECRET:10}"; done; echo done`,
  });
  const result = await monitors.wait(started.id, 10_000);
  assert.equal(result.status, "exited");
  assert.ok(!result.output.includes(token));
  assert.equal(result.output.split(redactedText).length - 1, 3);
  const log = await readFile(path.join(root, started.log), "utf8");
  assert.ok(!log.includes(token));
  assert.ok(log.endsWith("done\n"));
  assert.ok(monitorLimits.logBytes > log.length);
});
