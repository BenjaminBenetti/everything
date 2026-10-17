import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { OpenSshAgent } from "../adapter/open-ssh-agent.js";

const execute = promisify(execFile);

/** Generate disposable OpenSSH fixtures that are never used against an external service. */
async function createKey(directory: string, name: string, passphrase = "") {
  const file = path.join(directory, name);
  await execute("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    passphrase,
    "-C",
    name,
    "-f",
    file,
  ]);
  return {
    file,
    material: await readFile(file, "utf8"),
    publicKey: await readFile(`${file}.pub`, "utf8"),
  };
}

test("OpenSSH loads keys through stdin, signs, removes deleted keys, and skips unusable entries", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "keys-ssh-"));
  const agent = new OpenSshAgent(path.join(root, "managed", "agent.sock"));
  context.after(async () => {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = await createKey(root, "first");
  const second = await createKey(root, "second");
  const locked = await createKey(root, "locked", "disposable-test-passphrase");
  await Promise.all([agent.start(), agent.start()]);
  const empty = await agent.inventory();
  assert.equal((await lstat(agent.socketPath)).mode & 0o777, 0o600);
  assert.equal(
    (await lstat(path.dirname(agent.socketPath))).mode & 0o777,
    0o700,
  );
  assert.deepEqual(
    await agent.replace([
      { id: "first", material: first.material.trim() },
      { id: "public", material: first.publicKey },
      { id: "locked", material: locked.material },
      { id: "broken", material: "invalid private key" },
    ]),
    [
      { id: "first", loaded: true },
      { id: "public", loaded: false },
      { id: "locked", loaded: false },
      { id: "broken", loaded: false },
    ],
  );
  const environment = {
    PATH: "/usr/bin:/bin",
    SSH_AUTH_SOCK: agent.socketPath,
  };
  await execute("ssh-add", ["-T", `${first.file}.pub`], { env: environment });
  assert.notEqual(await agent.inventory(), empty);
  assert.deepEqual(
    await agent.replace([{ id: "second", material: second.material }]),
    [{ id: "second", loaded: true }],
  );
  await assert.rejects(
    execute("ssh-add", ["-T", `${first.file}.pub`], { env: environment }),
  );
  await execute("ssh-add", ["-T", `${second.file}.pub`], { env: environment });
  await agent.replace([]);
  assert.equal(await agent.inventory(), empty);
  await agent.close();
  await assert.rejects(lstat(agent.socketPath), { code: "ENOENT" });
});

test("an agent can restart at the same path without retaining identities or private key files", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "keys-ssh-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = new OpenSshAgent(path.join(root, "managed", "agent.sock"));
  const second = new OpenSshAgent(first.socketPath);
  context.after(async () => {
    await first.close();
    await second.close();
  });
  const key = await createKey(root, "fixture");
  await first.start();
  const empty = await first.inventory();
  await first.replace([{ id: "key", material: key.material }]);
  await first.close();
  await second.start();
  assert.equal(await second.inventory(), empty);
  await second.replace([{ id: "key", material: key.material }]);
  assert.notEqual(await second.inventory(), empty);
});
