import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionCipher } from "@everything/security/session-cipher";
import { OpenSshAgent } from "../adapter/open-ssh-agent.js";
import type { SshAgent } from "../interface/ssh-agent.js";
import type { EncryptedSshIdentity } from "../interface/ssh-key-source.js";
import { SshKeySynchronizer } from "../service/ssh-key-synchronizer.js";
import { corruptPrivateKey, createKey, lockAgent } from "./ssh-key-fixtures.js";

/** Exercise convergence with an independent durable source and a controllable authentication process. */
async function fixture() {
  const cipher = new SessionCipher(Buffer.alloc(32, 9).toString("base64"));
  const state = {
    records: [
      { id: "one", encryptedMaterial: await cipher.seal("first private key") },
    ] as EncryptedSshIdentity[],
    /** Public key to the material behind it, as the agent holds them. */
    held: new Map<string, string>(),
    added: [] as string[],
    removed: [] as string[],
    opened: 0,
    restarts: 0,
    failures: [] as unknown[][],
    broken: false,
    crashed: false,
    locked: false,
    release: undefined as undefined | (() => void),
    block: false,
    readCount: 0,
  };
  const agent: SshAgent = {
    socketPath: "/unused/agent.sock",
    /** Recover a simulated process exit, which loses every identity. */
    async start() {
      if (state.crashed) {
        state.held.clear();
        state.crashed = false;
      }
    },
    /** Replace the process with an empty, unlocked one. */
    async restart() {
      state.restarts++;
      state.held.clear();
      state.locked = false;
      state.crashed = false;
    },
    /** A locked agent offers nothing. */
    async identities() {
      return new Set(state.locked ? [] : state.held.keys());
    },
    /** Return nothing for unusable material, and throw while locked, as OpenSSH's adapter does. */
    async add(material) {
      if (state.locked) throw new Error("refused");
      if (material === "unusable") return undefined;
      const publicKey = `public:${material}`;
      state.held.set(publicKey, material);
      state.added.push(publicKey);
      return publicKey;
    },
    /** A locked agent, or one without the identity, refuses removal. */
    async remove(publicKey) {
      if (state.locked || !state.held.delete(publicKey))
        throw new Error("refused");
      state.removed.push(publicKey);
    },
    /** Empty the process on shutdown. */
    async close() {
      state.held.clear();
    },
  };
  const source = {
    /** Fail closed on source errors; a captured old snapshot can be released after a mutation. */
    async read() {
      state.readCount++;
      if (state.broken) throw new Error("Database unavailable");
      const snapshot = structuredClone(state.records);
      if (state.block) {
        state.block = false;
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      }
      return snapshot;
    },
  };
  const counting = {
    /** Count decryptions so unchanged keys are shown to stay loaded without reloading. */
    async open(value: string) {
      state.opened++;
      return cipher.open(value);
    },
  };
  const service = new SshKeySynchronizer(
    source,
    counting,
    agent,
    (...args: unknown[]) => {
      state.failures.push(args);
    },
  );
  return { state, service, cipher };
}

test("adds and removes one key at a time, leaving unrelated identities loaded", async () => {
  const { state, service, cipher } = await fixture();
  await service.refresh();
  assert.equal(service.status("one"), "ready");
  state.held.set("public:unrelated", "unrelated key");
  state.records.push({
    id: "two",
    encryptedMaterial: await cipher.seal("second private key"),
  });
  await service.refresh();
  await service.refresh();
  assert.deepEqual(state.added, [
    "public:first private key",
    "public:second private key",
  ]);
  assert.equal(state.opened, 2);
  state.records.shift();
  await service.refresh();
  assert.deepEqual(state.removed, ["public:first private key"]);
  assert.deepEqual(
    new Set(state.held.keys()),
    new Set(["public:second private key", "public:unrelated"]),
  );
  assert.equal(service.status("two"), "ready");
  assert.equal(service.status("one"), "pending");
  assert.equal(state.restarts, 0);
  assert.deepEqual(state.failures, []);
  await service.close();
});

test("a key removed behind Everything's back is loaded again; a shared public key stays while still saved", async () => {
  const { state, service, cipher } = await fixture();
  state.records.push({
    id: "copy",
    encryptedMaterial: await cipher.seal("first private key"),
  });
  await service.refresh();
  state.held.delete("public:first private key");
  await service.refresh();
  assert.ok(state.held.has("public:first private key"));
  state.records = state.records.filter((record) => record.id !== "one");
  await service.refresh();
  assert.ok(state.held.has("public:first private key"));
  assert.deepEqual(state.removed, []);
  state.records = [];
  await service.refresh();
  assert.deepEqual([...state.held.keys()], []);
  assert.equal(state.restarts, 0);
  await service.close();
});

test("an exited agent is started again and reloaded; a locked one is replaced and loses deleted keys", async () => {
  const { state, service, cipher } = await fixture();
  state.records.push({
    id: "two",
    encryptedMaterial: await cipher.seal("second private key"),
  });
  await service.refresh();
  state.crashed = true;
  await service.refresh();
  assert.equal(state.held.size, 2);
  assert.equal(state.restarts, 0);
  state.locked = true;
  state.records.shift();
  await service.refresh();
  assert.equal(state.restarts, 1);
  assert.equal(state.locked, false);
  assert.deepEqual([...state.held.keys()], ["public:second private key"]);
  assert.equal(service.status("two"), "ready");
  state.locked = true;
  await service.refresh();
  assert.equal(state.restarts, 2);
  assert.deepEqual([...state.held.keys()], ["public:second private key"]);
  assert.deepEqual(state.failures, []);
  await service.close();
});

test("source failures preserve loaded keys; corrupt and unusable records cannot block other keys", async () => {
  const { state, service, cipher } = await fixture();
  await service.refresh();
  state.broken = true;
  await service.refresh();
  assert.deepEqual([...state.held.keys()], ["public:first private key"]);
  assert.deepEqual(state.failures, [[]]);
  assert.equal(service.status("one"), "pending");
  state.broken = false;
  state.records.push(
    { id: "corrupt", encryptedMaterial: "broken ciphertext" },
    { id: "unusable", encryptedMaterial: await cipher.seal("unusable") },
  );
  await service.refresh();
  await service.refresh();
  assert.equal(service.status("one"), "ready");
  assert.equal(service.status("unusable"), "unavailable");
  assert.equal(service.status("corrupt"), "unavailable");
  assert.deepEqual([...state.held.keys()], ["public:first private key"]);
  assert.equal(state.opened, 3);
  assert.equal(state.restarts, 0);
  await service.close();
});

test("a deletion during synchronization cannot be lost behind an older snapshot", async () => {
  const { state, service } = await fixture();
  state.block = true;
  const first = service.refresh();
  state.records = [];
  const deletion = service.refresh();
  state.release!();
  await Promise.all([first, deletion]);
  assert.equal(state.readCount, 2);
  assert.deepEqual([...state.held.keys()], []);
  await service.close();
});

test("a key saved while the empty agent is locked loads once the agent is replaced", async () => {
  const { state, service, cipher } = await fixture();
  state.records = [];
  await service.refresh();
  state.locked = true;
  state.records.push({
    id: "first",
    encryptedMaterial: await cipher.seal("first private key"),
  });
  await service.refresh();
  assert.equal(service.status("first"), "ready");
  assert.equal(state.restarts, 1);
  assert.deepEqual([...state.held.keys()], ["public:first private key"]);
  await service.close();
});

test("OpenSSH: a locked empty agent is replaced for a new key, and damaged material is not retried", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "keys-sync-"));
  const cipher = new SessionCipher(Buffer.alloc(32, 7).toString("base64"));
  const agent = new OpenSshAgent(path.join(root, "private", "agent.sock"));
  let restarts = 0;
  const restart = agent.restart.bind(agent);
  agent.restart = async () => {
    restarts++;
    await restart();
  };
  const records: EncryptedSshIdentity[] = [];
  const failures: unknown[][] = [];
  const service = new SshKeySynchronizer(
    { read: async () => [...records] },
    cipher,
    agent,
    (...args: unknown[]) => {
      failures.push(args);
    },
  );
  context.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const key = await createKey(root, "valid");
  const damaged = await createKey(root, "damaged");
  await service.start();
  assert.equal(await lockAgent(agent.socketPath), 6);
  records.push({
    id: "valid",
    encryptedMaterial: await cipher.seal(key.material),
  });
  await service.refresh();
  assert.equal(service.status("valid"), "ready");
  assert.equal(restarts, 1);
  assert.deepEqual(await agent.identities(), new Set([key.blob]));
  records.push({
    id: "damaged",
    encryptedMaterial: await cipher.seal(corruptPrivateKey(damaged.material)),
  });
  for (let pass = 0; pass < 3; pass++) await service.refresh();
  assert.equal(service.status("damaged"), "unavailable");
  assert.equal(service.status("valid"), "ready");
  assert.equal(restarts, 1);
  assert.deepEqual(await agent.identities(), new Set([key.blob]));
  assert.deepEqual(failures, []);
});
