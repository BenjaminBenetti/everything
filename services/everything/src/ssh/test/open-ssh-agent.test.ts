import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import pRetry from "p-retry";
import { OpenSshAgent } from "../adapter/open-ssh-agent.js";
import { createKey, killAgent, lockAgent, sshAdd } from "./ssh-key-fixtures.js";

test("OpenSSH adds and removes single keys through stdin while other identities stay loaded", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "keys-ssh-"));
  const agent = new OpenSshAgent(path.join(root, "managed", "agent.sock"));
  context.after(async () => {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = await createKey(root, "first");
  const second = await createKey(root, "second");
  const unrelated = await createKey(root, "unrelated");
  const locked = await createKey(root, "locked", {
    passphrase: "disposable-test-passphrase",
  });
  await Promise.all([agent.start(), agent.start()]);
  assert.deepEqual([...(await agent.identities())], []);
  assert.equal((await lstat(agent.socketPath)).mode & 0o777, 0o600);
  assert.equal(
    (await lstat(path.dirname(agent.socketPath))).mode & 0o777,
    0o700,
  );
  assert.equal(await agent.add(first.material.trim()), first.blob);
  assert.equal(await agent.add(second.material), second.blob);
  assert.equal(await sshAdd(agent.socketPath, [unrelated.file]), 0);
  assert.equal(await agent.add(first.publicKey), undefined);
  assert.equal(await agent.add(locked.material), undefined);
  assert.equal(await agent.add("invalid private key"), undefined);
  assert.deepEqual(
    await agent.identities(),
    new Set([first.blob, second.blob, unrelated.blob]),
  );
  await agent.remove(first.blob);
  assert.deepEqual(
    await agent.identities(),
    new Set([second.blob, unrelated.blob]),
  );
  assert.notEqual(
    await sshAdd(agent.socketPath, ["-T", `${first.file}.pub`]),
    0,
  );
  assert.equal(await sshAdd(agent.socketPath, ["-T", `${second.file}.pub`]), 0);
  await assert.rejects(agent.remove(first.blob));
  assert.deepEqual(await readdir(path.dirname(agent.socketPath)), [
    "agent.sock",
  ]);
  await agent.close();
  await assert.rejects(lstat(agent.socketPath), { code: "ENOENT" });
});

test("a locked or exited agent is replaced at the same path without its identities", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "keys-ssh-"));
  const agent = new OpenSshAgent(path.join(root, "managed", "agent.sock"));
  context.after(async () => {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  });
  const key = await createKey(root, "fixture");
  await agent.start();
  assert.equal(await agent.add(key.material), key.blob);
  assert.equal(await lockAgent(agent.socketPath), 6);
  assert.deepEqual([...(await agent.identities())], []);
  assert.equal(await agent.add(key.material), undefined);
  await assert.rejects(agent.remove(key.blob));
  await agent.restart();
  assert.deepEqual([...(await agent.identities())], []);
  assert.equal(await agent.add(key.material), key.blob);
  await killAgent(agent.socketPath);
  await assert.rejects(agent.identities());
  // start() relaunches once Node has reaped the killed child.
  await pRetry(
    async () => {
      await agent.start();
      assert.deepEqual([...(await agent.identities())], []);
    },
    { retries: 20, minTimeout: 25, maxTimeout: 100 },
  );
  assert.equal(await agent.add(key.material), key.blob);
});

test("a new agent at a closed agent's path starts empty", async (context) => {
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
  await first.add(key.material);
  await first.close();
  await second.start();
  assert.deepEqual([...(await second.identities())], []);
});
