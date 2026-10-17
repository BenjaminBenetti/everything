import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionCipher } from "@everything/security/session-cipher";
import type { SshAgent, SshIdentity } from "../interface/ssh-agent.js";
import type { EncryptedSshIdentity } from "../interface/ssh-key-source.js";
import { SshKeySynchronizer } from "../service/ssh-key-synchronizer.js";

/** Exercise convergence with an independent durable source and a controllable authentication process. */
async function fixture() {
  const cipher = new SessionCipher(Buffer.alloc(32, 9).toString("base64"));
  const state = {
    records: [
      { id: "one", encryptedMaterial: await cipher.seal("first private key") },
    ] as EncryptedSshIdentity[],
    loaded: [] as SshIdentity[],
    replaces: 0,
    failures: 0,
    broken: false,
    crashed: false,
    release: undefined as undefined | (() => void),
    block: false,
    readCount: 0,
  };
  const agent: SshAgent = {
    socketPath: "/unused/agent.sock",
    /** Recover a simulated process failure without retaining in-memory identities. */
    async start() {
      if (state.crashed) {
        state.loaded = [];
        state.crashed = false;
      }
    },
    /** Reflect external additions and removals independently of the source. */
    async inventory() {
      return JSON.stringify(state.loaded.map((key) => key.id));
    },
    /** Track authoritative replacement and simulate a locked private key. */
    async replace(keys) {
      state.replaces++;
      state.loaded = keys.filter((key) => key.material !== "locked");
      return keys.map((key) => ({
        id: key.id,
        loaded: key.material !== "locked",
      }));
    },
    /** Empty the process on shutdown. */
    async close() {
      state.loaded = [];
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
  const service = new SshKeySynchronizer(source, cipher, agent, () => {
    state.failures++;
  });
  return { state, service, cipher };
}

test("SSH synchronization loads new keys, removes deleted keys, repairs drift and restores after process failure", async () => {
  const { state, service, cipher } = await fixture();
  await service.refresh();
  assert.equal(service.status("one"), "ready");
  await service.refresh();
  assert.equal(state.replaces, 1);
  state.records.push({
    id: "two",
    encryptedMaterial: await cipher.seal("second private key"),
  });
  await service.refresh();
  assert.deepEqual(
    state.loaded.map((key) => key.id),
    ["one", "two"],
  );
  state.records.shift();
  await service.refresh();
  assert.deepEqual(
    state.loaded.map((key) => key.id),
    ["two"],
  );
  state.loaded.push({ id: "external", material: "external key" });
  await service.refresh();
  assert.deepEqual(
    state.loaded.map((key) => key.id),
    ["two"],
  );
  state.crashed = true;
  await service.refresh();
  assert.deepEqual(
    state.loaded.map((key) => key.id),
    ["two"],
  );
  state.records = [];
  await service.refresh();
  assert.deepEqual(state.loaded, []);
  await service.close();
});

test("source failures preserve loaded keys; corrupt and locked records cannot block other keys", async () => {
  const { state, service, cipher } = await fixture();
  await service.refresh();
  state.broken = true;
  await service.refresh();
  assert.equal(state.loaded[0]?.id, "one");
  assert.equal(state.failures, 1);
  assert.equal(service.status("one"), "pending");
  state.broken = false;
  state.records.push(
    { id: "corrupt", encryptedMaterial: "broken ciphertext" },
    { id: "locked", encryptedMaterial: await cipher.seal("locked") },
  );
  await service.refresh();
  assert.equal(service.status("one"), "ready");
  assert.equal(service.status("locked"), "unavailable");
  assert.equal(service.status("corrupt"), "unavailable");
  assert.deepEqual(
    state.loaded.map((key) => key.id),
    ["one"],
  );
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
  assert.deepEqual(state.loaded, []);
  await service.close();
});
