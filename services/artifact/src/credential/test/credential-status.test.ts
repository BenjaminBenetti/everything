import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialSecretName } from "../../cluster/model/cluster-names.js";
import {
  formatCredentialEntries,
  parseCredentialEntries,
  type CredentialBinding,
  type CredentialEntry,
} from "../model/credential-binding.js";
import {
  appCredentialStates,
  holdsWithdrawnCredential,
  type AppCredentialObservation,
  type PodCredentials,
} from "../model/credential-status.js";
import { redactCredentials } from "../service/app-credentials.js";

const artifactId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
const credentialId = "0b6f4d4e-2a1c-4f53-8f6e-3c0f3ad1d001";
const other = "0b6f4d4e-2a1c-4f53-8f6e-3c0f3ad1d002";

/** A grant of the test credential at a version. */
function binding(version: number, env = "TOKEN"): CredentialBinding {
  return {
    id: `binding-${env}`,
    ownerId: "owner",
    artifactId,
    createdAt: "2026-10-22T00:00:00.000Z",
    credentialId,
    env,
    version,
    valueId: null,
  };
}

/** An entry a pod holds. */
function entry(
  version: number,
  env = "TOKEN",
  id = credentialId,
): CredentialEntry {
  return { env, credentialId: id, version };
}

/** A pod holding entries. */
function pod(
  entries: CredentialEntry[],
  state: Partial<Omit<PodCredentials, "entries">> = {},
): PodCredentials {
  return { ready: true, terminating: false, entries, ...state };
}

/** An observation with defaults for a running app with a stored v1 copy. */
function observe(
  changes: Partial<AppCredentialObservation>,
): ReturnType<typeof appCredentialStates> {
  return appCredentialStates({
    artifactId,
    running: true,
    bindings: [binding(1)],
    records: new Map(),
    stored: new Set([credentialSecretName(artifactId, credentialId, 1)]),
    pods: [pod([entry(1)])],
    ...changes,
  });
}

/** The statuses of an observation's credentials. */
function statuses(changes: Partial<AppCredentialObservation>) {
  return observe(changes).map(({ env, version, status }) => [
    env,
    version,
    status,
  ]);
}

test("a grant is applied only when a ready pod serves it and no pod holds another version", () => {
  assert.deepEqual(statuses({}), [["TOKEN", 1, "applied"]]);
  assert.deepEqual(statuses({ pods: [] }), [["TOKEN", 1, "pending"]]);
  assert.deepEqual(statuses({ pods: [pod([entry(1)], { ready: false })] }), [
    ["TOKEN", 1, "pending"],
  ]);
  assert.deepEqual(
    statuses({
      bindings: [binding(2)],
      stored: new Set([credentialSecretName(artifactId, credentialId, 2)]),
      pods: [pod([entry(2)]), pod([entry(1)], { terminating: true })],
    }),
    [["TOKEN", 2, "pending"]],
    "a stopping process with the old value keeps the new one pending",
  );
});

test("a newer delivered version, a missing copy, and a stopped app take precedence in that order", () => {
  const records = new Map([
    [
      credentialId,
      {
        id: credentialId,
        createdAt: "",
        version: 2,
        valueId: null,
        revokedAt: null,
      },
    ],
  ]);
  assert.deepEqual(statuses({ records }), [["TOKEN", 1, "updating"]]);
  assert.deepEqual(statuses({ stored: new Set() }), [["TOKEN", 1, "missing"]]);
  assert.deepEqual(statuses({ stored: undefined, running: false, pods: [] }), [
    ["TOKEN", 1, "stopped"],
  ]);
});

test("withdrawn credentials a process still holds are listed as removing", () => {
  assert.deepEqual(
    statuses({
      bindings: [],
      pods: [pod([entry(1), entry(3, "OTHER", other)], { terminating: true })],
    }),
    [
      ["OTHER", 3, "removing"],
      ["TOKEN", 1, "removing"],
    ],
  );
});

test("only a live process holding a withdrawn credential or an older version must be replaced", () => {
  assert.equal(holdsWithdrawnCredential([pod([entry(1)])], [entry(1)]), false);
  assert.equal(holdsWithdrawnCredential([pod([entry(1)])], [entry(2)]), true);
  assert.equal(holdsWithdrawnCredential([pod([entry(1)])], []), true);
  assert.equal(
    holdsWithdrawnCredential([pod([entry(1)], { terminating: true })], []),
    false,
    "pods already stopping aren't deleted again",
  );
  assert.equal(holdsWithdrawnCredential([pod([])], [entry(1)]), false);
});

test("pod annotations carry identifiers in a stable order and malformed entries are ignored", () => {
  const entries = [entry(2, "B"), entry(1, "A", other)];
  const annotation = formatCredentialEntries(entries);
  assert.equal(annotation, `A=${other}@1,B=${credentialId}@2`);
  assert.deepEqual(parseCredentialEntries(annotation), [
    entry(1, "A", other),
    entry(2, "B"),
  ]);
  assert.deepEqual(
    parseCredentialEntries(`A=${other}@0,B=nope@1,=x@1,C=${credentialId}@3`),
    [entry(3, "C")],
  );
});

test("log redaction replaces exact values, longest first, and leaves short values alone", () => {
  assert.equal(
    redactCredentials("a=secret-long b=secret-long-er c=abc", [
      { env: "A", value: "secret-long" },
      { env: "B", value: "secret-long-er" },
      { env: "C", value: "abc" },
    ]),
    "a=[credential A] b=[credential B] c=abc",
  );
});

test("a stopped app's credential isn't reported stopped while a process still holds any version of it", () => {
  const stoppedRotated = {
    running: false,
    bindings: [binding(2)],
    stored: new Set([credentialSecretName(artifactId, credentialId, 2)]),
  };
  assert.deepEqual(
    statuses({
      ...stoppedRotated,
      // The old pod is still terminating, possibly forever on an unreachable node.
      pods: [pod([entry(1)], { terminating: true })],
    }),
    [["TOKEN", 2, "pending"]],
  );
  assert.deepEqual(
    statuses({
      ...stoppedRotated,
      pods: [pod([entry(2)], { terminating: true, ready: false })],
    }),
    [["TOKEN", 2, "pending"]],
    "the app is still stopping",
  );
  assert.deepEqual(statuses({ ...stoppedRotated, pods: [] }), [
    ["TOKEN", 2, "stopped"],
  ]);
  assert.deepEqual(
    statuses({ ...stoppedRotated, pods: [pod([entry(3, "OTHER", other)])] }),
    [
      ["TOKEN", 2, "stopped"],
      ["OTHER", 3, "removing"],
    ],
    "another credential's holder doesn't change this one",
  );
});
