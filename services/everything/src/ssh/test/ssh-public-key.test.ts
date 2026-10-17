import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sshPublicKey } from "../adapter/ssh-public-key.js";
import { createKey } from "./ssh-key-fixtures.js";

test("reads the public key of unencrypted OpenSSH and PEM private keys", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "keys-public-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const keys = await Promise.all([
    createKey(root, "ed25519"),
    createKey(root, "rsa", { type: "rsa" }),
    createKey(root, "ecdsa", { type: "ecdsa" }),
    createKey(root, "rsa-pem", { type: "rsa", format: "PEM" }),
    createKey(root, "ecdsa-pem", { type: "ecdsa", format: "PEM" }),
    createKey(root, "rsa-pkcs8", { type: "rsa", format: "PKCS8" }),
  ]);
  for (const key of keys) {
    assert.equal(sshPublicKey(key.material), key.blob, key.file);
    assert.equal(
      sshPublicKey(key.material.trim().replace(/\n/g, "\r\n")),
      key.blob,
    );
  }
});

test("finds no usable public key in public keys, passphrase-protected keys, or malformed input", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "keys-public-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const key = await createKey(root, "plain");
  const locked = await createKey(root, "locked", {
    passphrase: "disposable-test-passphrase",
  });
  const lockedPem = await createKey(root, "locked-pem", {
    type: "rsa",
    format: "PEM",
    passphrase: "disposable-test-passphrase",
  });
  assert.equal(sshPublicKey(key.publicKey), undefined);
  assert.equal(sshPublicKey(locked.material), undefined);
  assert.equal(sshPublicKey(lockedPem.material), undefined);
  assert.equal(sshPublicKey("not a key"), undefined);
  assert.equal(
    sshPublicKey(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
    ),
    undefined,
  );
});
