import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { SessionCipher } from "@everything/security/session-cipher";
import { OpenSshAgent } from "../adapter/open-ssh-agent.js";
import { createSshRuntime } from "../factory/ssh-runtime.js";
import type { EncryptedSshIdentity } from "../interface/ssh-key-source.js";
import { fleetGitAgentSocket } from "../model/ssh-sockets.js";
import {
  cloneRepository,
  createRepository,
  startGitServer,
} from "./ssh-git-fixtures.js";
import { createKey, killAgent, lockAgent, sshAdd } from "./ssh-key-fixtures.js";

/**
 * A disposable installation: synthetic keys, two loopback Git servers, Everything's SSH runtime
 * with the chart's socket layout under a temporary root, and an agent standing in for Fleet's relay
 * while a Fleet client is attached. Nothing reaches a real remote, key, agent, or known_hosts file.
 */
async function installation(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "keys-git-"));
  const fixtures = path.join(root, "fixtures");
  await mkdir(fixtures);
  const saved = await createKey(fixtures, "saved");
  const remote = await createKey(fixtures, "client");
  await createRepository(fixtures, "private", "saved key repository\n");
  await createRepository(fixtures, "client", "client key repository\n");
  const savedServer = await startGitServer(fixtures, fixtures, [
    saved.publicKey,
  ]);
  const clientServer = await startGitServer(fixtures, fixtures, [
    remote.publicKey,
  ]);
  const cipher = new SessionCipher(randomBytes(32).toString("base64"));
  const records: EncryptedSshIdentity[] = [];
  const failures: unknown[][] = [];
  const sockets = {
    agent: path.join(root, "private", "agent.sock"),
    consumers: path.join(root, "workspace", ".ssh-agent", "agent.sock"),
    fleetGit: path.join(root, "private", "fleet-git.sock"),
    fleetClients: path.join(root, "fleet", ".fleet", "ssh-agent", "agent.sock"),
  };
  const runtime = createSshRuntime(
    { read: async () => [...records] },
    cipher,
    sockets,
    (...args: unknown[]) => {
      failures.push(args);
    },
  );
  const fleetClient = new OpenSshAgent(sockets.fleetClients);
  const logged: string[] = [];
  for (const method of ["log", "info", "warn", "error"] as const)
    context.mock.method(console, method, (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  context.after(async () => {
    await runtime.close();
    await fleetClient.close();
    await savedServer.close();
    await clientServer.close();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.start();
  return {
    root,
    saved,
    remote,
    savedServer,
    clientServer,
    cipher,
    records,
    failures,
    sockets,
    runtime,
    fleetClient,
    logged,
    /** Save the synthetic key as the key API would: encrypted, then synchronized. */
    async save() {
      records.push({
        id: "saved",
        encryptedMaterial: await cipher.seal(saved.material),
      });
      await runtime.keys.refresh();
    },
    /** Delete every saved key and wait for synchronization. */
    async deleteAll() {
      records.length = 0;
      await runtime.keys.refresh();
    },
    /** Fail if any runtime directory holds anything but sockets, or output mentions key material. */
    async assertNoPlaintext() {
      for (const directory of [
        path.dirname(sockets.agent),
        path.dirname(sockets.consumers),
      ])
        for (const entry of await readdir(directory))
          assert.ok(
            (await lstat(path.join(directory, entry))).isSocket(),
            `${entry} is a socket`,
          );
      const secret = saved.material.split("\n")[1]!;
      for (const line of logged) assert.ok(!line.includes(secret));
      for (const args of failures) assert.deepEqual(args, []);
    },
  };
}

test("teammate pods clone a private repository with a saved key and lose access when it is deleted", async (context) => {
  const setup = await installation(context);
  const teammate = {
    agent: setup.sockets.consumers,
    knownHosts: setup.savedServer.knownHosts,
  };
  const before = await cloneRepository(
    setup.root,
    setup.savedServer,
    "private.git",
    teammate,
  );
  assert.equal(before.ok, false);
  await setup.save();
  assert.equal(setup.runtime.keys.status("saved"), "ready");
  const cloned = await cloneRepository(
    setup.root,
    setup.savedServer,
    "private.git",
    teammate,
  );
  assert.equal(cloned.readme, "saved key repository\n", cloned.output);
  assert.notEqual(await sshAdd(setup.sockets.consumers, ["-D"]), 0);
  assert.equal(await lockAgent(setup.sockets.consumers), 5);
  assert.equal(
    (
      await cloneRepository(
        setup.root,
        setup.savedServer,
        "private.git",
        teammate,
      )
    ).ok,
    true,
  );
  const unknownHost = await cloneRepository(
    setup.root,
    setup.savedServer,
    "private.git",
    { ...teammate, knownHosts: "/dev/null" },
  );
  assert.equal(unknownHost.ok, false);
  assert.match(unknownHost.output, /Host key verification failed/);
  await setup.deleteAll();
  assert.equal(
    (
      await cloneRepository(
        setup.root,
        setup.savedServer,
        "private.git",
        teammate,
      )
    ).ok,
    false,
  );
  await setup.assertNoPlaintext();
});

test("a crashed or locked agent is restored with the saved keys on the next pass", async (context) => {
  const setup = await installation(context);
  const teammate = {
    agent: setup.sockets.consumers,
    knownHosts: setup.savedServer.knownHosts,
  };
  await setup.save();
  await killAgent(setup.sockets.agent);
  // The next pass, from the five-second timer or a key change, restores it.
  await setup.runtime.keys.refresh();
  const restarted = await cloneRepository(
    setup.root,
    setup.savedServer,
    "private.git",
    teammate,
  );
  assert.equal(restarted.ok, true, restarted.output);
  assert.equal(await lockAgent(setup.sockets.agent), 6);
  // The next pass, from the five-second timer or a key change, restores it.
  await setup.runtime.keys.refresh();
  const unlocked = await cloneRepository(
    setup.root,
    setup.savedServer,
    "private.git",
    teammate,
  );
  assert.equal(unlocked.ok, true, unlocked.output);
  assert.equal(setup.runtime.keys.status("saved"), "ready");
  await setup.assertNoPlaintext();
});

test("Fleet's Git uses saved keys even while an attached client provides its own agent", async (context) => {
  const setup = await installation(context);
  await setup.save();
  await setup.fleetClient.start();
  assert.equal(
    await setup.fleetClient.add(setup.remote.material),
    setup.remote.blob,
  );
  // fleetd points its children's SSH_AUTH_SOCK at its relay, which answers with the client's agent.
  const redirected = { agent: setup.sockets.fleetClients };
  const shadowed = await cloneRepository(
    setup.root,
    setup.savedServer,
    "private.git",
    { ...redirected, knownHosts: setup.savedServer.knownHosts },
  );
  assert.equal(shadowed.ok, false);
  const fleetGit = { ...redirected, identityAgent: setup.sockets.fleetGit };
  const saved = await cloneRepository(
    setup.root,
    setup.savedServer,
    "private.git",
    { ...fleetGit, knownHosts: setup.savedServer.knownHosts },
  );
  assert.equal(saved.readme, "saved key repository\n", saved.output);
  const client = await cloneRepository(
    setup.root,
    setup.clientServer,
    "client.git",
    { ...fleetGit, knownHosts: setup.clientServer.knownHosts },
  );
  assert.equal(client.readme, "client key repository\n", client.output);
  await setup.fleetClient.close();
  const detached = await cloneRepository(
    setup.root,
    setup.savedServer,
    "private.git",
    { ...fleetGit, knownHosts: setup.savedServer.knownHosts },
  );
  assert.equal(detached.ok, true, detached.output);
  const unknownHost = await cloneRepository(
    setup.root,
    setup.savedServer,
    "private.git",
    { ...fleetGit, knownHosts: "/dev/null" },
  );
  assert.match(unknownHost.output, /Host key verification failed/);
  await setup.assertNoPlaintext();
});

test("Everything's image points Git's SSH client at the Fleet Git socket without relaxing host checks", async () => {
  const dockerfile = await readFile(
    new URL("../../../container/Dockerfile", import.meta.url),
    "utf8",
  );
  assert.ok(dockerfile.includes(`IdentityAgent ${fleetGitAgentSocket}`));
  const hostTrust = await readFile(
    new URL(
      "../../../../../deployment/helm/files/ssh/10-everything.conf",
      import.meta.url,
    ),
    "utf8",
  );
  for (const file of [dockerfile, hostTrust])
    assert.doesNotMatch(
      file,
      /StrictHostKeyChecking|UserKnownHostsFile\s+\/dev\/null/i,
    );
});
