import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { monitorLimits } from "@everything/workspace-contracts/monitor";
import { WorkspaceFiles } from "../../workspace/service/workspace-files.js";
import { FileOutputSecrets } from "../adapter/file-output-secrets.js";
import { LinuxCommandProcessFactory } from "../adapter/linux-command-process-factory.js";
import { commandEnvironment } from "../model/command-environment.js";
import { defaultMonitorPolicy } from "../model/monitor-policy.js";
import { redactedText, SecretRedactor } from "../model/secret-redactor.js";
import { BashRunner } from "../service/bash-runner.js";
import { MonitorRunner } from "../service/monitor-runner.js";

const token = "0123456789abcdef".repeat(4);
/**
 * A token that begins and ends with the same character, so a stream holding all of it but the last
 * character and another holding only that character each hold back their whole part.
 */
const bordered = `a${"b".repeat(62)}a`;

/** An ordinary synthetic token, with no repeated beginning or end. */
const hashed = createHash("sha256")
  .update("independent-review-not-real-token")
  .digest("hex");

/** Redact `chunks` as one stream and return the text released. */
function redact(chunks: readonly string[], secrets = [token]): string {
  const redactor = new SecretRedactor(secrets);
  const write = redactor.stream();
  return Buffer.concat([
    ...chunks.map((chunk) => write(Buffer.from(chunk))),
    redactor.end(),
  ]).toString("utf8");
}

/** Real command supervision in an isolated workspace, with the token file's secret redacted. */
async function fixture(context: TestContext, secret = token) {
  const parent = await mkdtemp(path.join(tmpdir(), "redaction-"));
  const root = path.join(parent, "teammate");
  const shared = path.join(parent, "shared");
  await mkdir(root);
  await mkdir(shared);
  const files = new WorkspaceFiles(root, shared);
  const processes = new LinuxCommandProcessFactory();
  const environment = {
    ...commandEnvironment(process.env, root),
    SECRET: secret,
  };
  const tokenFile = path.join(parent, "token");
  await writeFile(tokenFile, `${secret}\n`);
  const secrets = new FileOutputSecrets([tokenFile]);
  const bash = new BashRunner(files, processes, environment, secrets);
  const monitors = new MonitorRunner(
    files,
    processes,
    defaultMonitorPolicy,
    environment,
    Date.now,
    secrets,
  );
  context.after(async () => {
    bash.close();
    await monitors.close();
    await rm(parent, { recursive: true, force: true });
  });
  return { root, tokenFile, bash, monitors };
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
  const write = new SecretRedactor([token]).stream();
  assert.equal(write(Buffer.from("progress 1\n")).toString(), "progress 1\n");
  assert.equal(
    write(Buffer.from(`next ${token.slice(0, 5)}`)).toString(),
    "next ",
  );
  assert.equal(write(Buffer.from("zzz")).toString(), `${token.slice(0, 5)}zzz`);
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

test("redacts a secret split between two joined streams, or split within one by the other's output", () => {
  /** Write `writes`, each to stream 0 or 1 of one joined output, and return the output released. */
  const joined = (writes: readonly [0 | 1, string][]): string => {
    const redactor = new SecretRedactor([bordered]);
    const streams = [redactor.stream(), redactor.stream()];
    return Buffer.concat([
      ...writes.map(([stream, text]) => streams[stream]!(Buffer.from(text))),
      redactor.end(),
    ]).toString("utf8");
  };
  // Each stream holds its whole part back until the end, which releases them joined.
  assert.equal(
    joined([
      [0, bordered.slice(0, 63)],
      [1, bordered.slice(63)],
    ]),
    redactedText,
  );
  assert.equal(
    joined([
      [1, `é ${bordered.slice(0, 1)}`],
      [0, `${bordered.slice(1)} 😀`],
    ]),
    `é ${redactedText} 😀`,
  );
  // The other stream's output between a stream's two parts does not hide the secret either.
  assert.equal(
    joined([
      [0, bordered.slice(0, 30)],
      [1, "progress\n"],
      [0, `${bordered.slice(30)}\n`],
    ]),
    // Output keeps its order, with the mark where the secret began.
    `${redactedText}progress\n\n`,
  );
  // A stream that stops after a possible beginning holds the others back only so far, then lets them through.
  const quiet = new SecretRedactor([bordered]);
  const [first, second] = [quiet.stream(), quiet.stream()];
  assert.equal(first(Buffer.from("a")).length, 0);
  assert.equal(second(Buffer.from("x".repeat(4095))).length, 0);
  assert.equal(second(Buffer.from("x")).toString(), `a${"x".repeat(4096)}`);
  // Plain output from both streams passes through in order.
  assert.equal(
    joined([
      [0, "out "],
      [1, "err "],
      [0, "done"],
    ]),
    "out err done",
  );
});

test("never joins what is left around a stream's secret into a new one", () => {
  const redactor = new SecretRedactor([hashed]);
  const [stdout, stderr] = [redactor.stream(), redactor.stream()];
  // Stderr's whole token surrounds stdout's beginning of one, which then meets stderr's last part.
  const output = Buffer.concat([
    stderr(Buffer.from(hashed.slice(0, 46))),
    stdout(Buffer.from(hashed.slice(0, 48))),
    stderr(Buffer.from(hashed.slice(46) + hashed.slice(48))),
    redactor.end(),
  ]).toString("utf8");
  assert.equal(output, `${redactedText}${redactedText}`);
});

test("holds back a bounded amount however streams stagger beginnings of a secret", () => {
  const redactor = new SecretRedactor([hashed]);
  const [first, second] = [redactor.stream(), redactor.stream()];
  // Each stream completes a secret only after the other has begun its next one.
  const writes: [(chunk: Buffer) => Buffer, string][] = [
    [first, hashed.slice(0, 32)],
    [second, hashed.slice(0, 32)],
  ];
  for (let cycle = 0; cycle < 200; cycle++)
    writes.push(
      [first, hashed.slice(32)],
      [first, hashed.slice(0, 32)],
      [second, hashed.slice(32)],
      [second, hashed.slice(0, 32)],
    );
  const released = Buffer.concat(
    writes.map(([write, text]) => write(Buffer.from(text))),
  ).toString("utf8");
  const rest = redactor.end().toString("utf8");
  // At most 8 KiB, so as many secrets as fit in it, are held until the end.
  const held = rest.split(redactedText).length - 1;
  assert.ok(
    held <= (2 * 4096) / hashed.length,
    `${held} secrets held to the end`,
  );
  assert.ok(!(released + rest).includes(hashed));
});

/** A command whose stdout's beginning of the token meets what is left of stderr's whole token. */
const reassembling =
  'printf "%s" "${SECRET:0:46}" >&2; sleep 0.1; printf "%s" "${SECRET:0:48}"; sleep 0.1; printf "%s%s" "${SECRET:46}" "${SECRET:48}" >&2';

test("Bash output never contains a token left around another stream's redacted one", async (context) => {
  const { bash } = await fixture(context, hashed);
  const result = await bash.run({ command: reassembling });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, `${redactedText}${redactedText}`);
});

test("monitor output and its log never contain a token left around another stream's redacted one", async (context) => {
  const { root, monitors } = await fixture(context, hashed);
  const started = await monitors.start({ command: reassembling });
  const result = await monitors.wait(started.id, 10_000);
  assert.equal(result.status, "exited");
  const log = await readFile(path.join(root, started.log), "utf8");
  for (const text of [result.output, log])
    assert.equal(text, `${redactedText}${redactedText}`);
});

/** Commands that print the bordered token split between stdout and stderr, both ways round. */
const splitBetweenStreams = [
  'printf "%s" "${SECRET:0:63}"; sleep 0.1; printf "%s" "${SECRET:63}" >&2',
  'printf "%s" "${SECRET:0:63}" >&2; sleep 0.1; printf "%s" "${SECRET:63}"',
  'printf "é %s" "${SECRET:0:1}"; sleep 0.1; printf "%s 😀" "${SECRET:1}" >&2',
];

test("Bash output never reassembles a token split between stdout and stderr", async (context) => {
  const { bash } = await fixture(context, bordered);
  const outputs = [];
  for (const command of splitBetweenStreams) {
    const result = await bash.run({ command });
    assert.equal(result.exitCode, 0);
    assert.ok(!result.output.includes(bordered));
    outputs.push(result.output);
  }
  assert.deepEqual(outputs, [
    redactedText,
    redactedText,
    `é ${redactedText} 😀`,
  ]);
});

test("monitor output, its snapshot, and its log never reassemble a token split between stdout and stderr", async (context) => {
  const { root, monitors } = await fixture(context, bordered);
  for (const [index, command] of splitBetweenStreams.entries()) {
    const started = await monitors.start({ command });
    const result = await monitors.wait(started.id, 10_000);
    assert.equal(result.status, "exited");
    const log = await readFile(path.join(root, started.log), "utf8");
    for (const text of [result.output, log]) {
      assert.ok(!text.includes(bordered));
      assert.equal(text, index === 2 ? `é ${redactedText} 😀` : redactedText);
    }
  }
});

test("redacts a token published or replaced after the workspace started", async (context) => {
  const { tokenFile, bash, monitors } = await fixture(context);
  const replaced = "fedcba9876543210".repeat(4);
  await writeFile(tokenFile, replaced);
  const command = `printf "%s" "${replaced}"`;
  assert.equal((await bash.run({ command })).output, redactedText);
  const started = await monitors.start({ command });
  assert.equal((await monitors.wait(started.id, 10_000)).output, redactedText);
});

test("never releases a secret or reorders output, however two streams interleave its parts and other output", () => {
  // A seeded generator keeps each case reproducible.
  let seed = 7;
  const random = (limit: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % limit;
  };
  const pieces = [
    bordered,
    bordered.slice(0, 63),
    bordered.slice(63),
    "a",
    "b",
    "ab",
    "é",
    "\n",
    "x",
  ];
  for (let round = 0; round < 2000; round++) {
    const redactor = new SecretRedactor([bordered]);
    const streams = [redactor.stream(), redactor.stream()];
    const written: string[] = [];
    const released: Buffer[] = [];
    for (let write = random(12); write >= 0; write--) {
      const text = pieces[random(pieces.length)]!;
      written.push(text);
      released.push(streams[random(2)]!(Buffer.from(text)));
    }
    released.push(redactor.end());
    const output = Buffer.concat(released).toString("utf8");
    assert.ok(
      !output.includes(bordered),
      JSON.stringify({ round, written, output }),
    );
    // What is left once each mark is removed comes from the joined output in order.
    const joined = written.join("");
    let at = 0;
    for (const character of output.replaceAll(redactedText, "")) {
      at = joined.indexOf(character, at);
      assert.ok(at >= 0, JSON.stringify({ round, written, output }));
      at += character.length;
    }
  }
});
