import assert from "node:assert/strict";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  agentMessage,
  agentRequest,
  frame,
  parseIdentities,
  sshString,
} from "../adapter/agent-protocol.js";
import { OpenSshAgent } from "../adapter/open-ssh-agent.js";
import { SshAgentRelay } from "../adapter/ssh-agent-relay.js";
import { createKey, sshAdd } from "./ssh-key-fixtures.js";

/** Two independent agents and a relay preferring the first, all in a disposable directory. */
async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), "keys-relay-"));
  const saved = new OpenSshAgent(path.join(root, "saved", "agent.sock"));
  const client = new OpenSshAgent(path.join(root, "client", "agent.sock"));
  const relay = new SshAgentRelay(path.join(root, "relay", "agent.sock"), [
    saved.socketPath,
    client.socketPath,
  ]);
  context.after(async () => {
    await relay.close();
    await saved.close();
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([saved.start(), client.start()]);
  await relay.start();
  return { root, saved, client, relay };
}

/** List the identities offered at `socket`, in order, as base64 public keys. */
async function listed(socket: string): Promise<string[]> {
  const reply = await agentRequest(
    socket,
    frame(agentMessage.requestIdentities),
    5000,
  );
  return parseIdentities(reply).map(({ blob }) => blob.toString("base64"));
}

test("offers every upstream's keys once, first upstream first, and signs with the agent that offered each", async (context) => {
  const { root, saved, client, relay } = await fixture(context);
  const first = await createKey(root, "first");
  const shared = await createKey(root, "shared");
  const remote = await createKey(root, "remote");
  await saved.add(first.material);
  await saved.add(shared.material);
  await client.add(remote.material);
  await client.add(shared.material);
  assert.deepEqual(
    new Set((await listed(relay.socketPath)).slice(0, 2)),
    new Set([first.blob, shared.blob]),
  );
  assert.equal((await listed(relay.socketPath))[2], remote.blob);
  assert.equal((await listed(relay.socketPath)).length, 3);
  assert.equal(await sshAdd(relay.socketPath, ["-T", `${first.file}.pub`]), 0);
  assert.equal(await sshAdd(relay.socketPath, ["-T", `${remote.file}.pub`]), 0);
  assert.equal(await sshAdd(relay.socketPath, ["-T", `${shared.file}.pub`]), 0);
  assert.equal((await lstat(relay.socketPath)).mode & 0o777, 0o600);
  assert.equal(
    (await lstat(path.dirname(relay.socketPath))).mode & 0o777,
    0o700,
  );
});

test("refuses to add, remove, wipe, or lock identities through the relay", async (context) => {
  const { root, saved, relay } = await fixture(context);
  const key = await createKey(root, "kept");
  const other = await createKey(root, "other");
  await saved.add(key.material);
  assert.notEqual(await sshAdd(relay.socketPath, [other.file]), 0);
  assert.notEqual(await sshAdd(relay.socketPath, ["-d", `${key.file}.pub`]), 0);
  assert.notEqual(await sshAdd(relay.socketPath, ["-D"]), 0);
  const lock = await agentRequest(
    relay.socketPath,
    frame(22, sshString("disposable-lock-password")),
    5000,
  );
  assert.equal(lock[4], agentMessage.failure);
  const query = await agentRequest(
    relay.socketPath,
    frame(agentMessage.extension, sshString("query")),
    5000,
  );
  assert.equal(query[4], agentMessage.failure);
  assert.deepEqual(await saved.identities(), new Set([key.blob]));
  assert.equal(await sshAdd(relay.socketPath, ["-T", `${key.file}.pub`]), 0);
});

test("keeps serving the reachable upstreams and drops connections that break the protocol", async (context) => {
  const { root, saved, client, relay } = await fixture(context);
  const key = await createKey(root, "available");
  await saved.add(key.material);
  await client.close();
  assert.deepEqual(await listed(relay.socketPath), [key.blob]);
  const closed = await new Promise<boolean>((resolve) => {
    const socket = createConnection(relay.socketPath, () => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(1024 * 1024);
      socket.write(header);
    });
    socket.on("error", () => resolve(true));
    socket.on("close", () => resolve(true));
    setTimeout(() => resolve(false), 5000).unref();
  });
  assert.equal(closed, true);
  await relay.close();
  await assert.rejects(lstat(relay.socketPath), { code: "ENOENT" });
});
