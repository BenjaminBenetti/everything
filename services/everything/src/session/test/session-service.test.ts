import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthenticationFailure } from "@everything/security/password-grant";
import { sessionFixture } from "./session-fixture.js";
import { sessionLifetimeMs } from "../model/stored-session.js";

const credentials = { username: "owner", password: "never-persist-this" };

test("persists encrypted tokens and scopes access to an unguessable cookie", async () => {
  const f = sessionFixture();
  const session = await f.service.signIn(credentials);
  const record = [...f.records.values()][0]!;
  assert.equal(record.ownerId, "owner");
  const saved = JSON.stringify(record);
  for (const secret of [
    credentials.password,
    session.handle,
    "access-0",
    "refresh-0",
  ])
    assert.ok(!saved.includes(secret));
  assert.equal(
    (await f.service.resolve(session.handle))?.profile.subject,
    "owner",
  );
  assert.equal(
    await f.service.resolve(session.handle.slice(0, 37) + "x".repeat(43)),
    undefined,
  );
  assert.equal(await f.service.resolve("invalid"), undefined);
  assert.equal(f.records.size, 1);
});

test("serializes concurrent refreshes and revokes the latest token on logout", async () => {
  const f = sessionFixture();
  const session = await f.service.signIn(credentials);
  f.advance(40_000);
  const resolved = await Promise.all(
    Array.from({ length: 8 }, () => f.service.resolve(session.handle)),
  );
  assert.equal(f.refreshCount(), 1);
  assert.ok(resolved.every((value) => value?.accessToken === "access-1"));
  await f.service.signOut(session.handle);
  assert.deepEqual(f.revoked, ["refresh-1"]);
  assert.equal(await f.service.resolve(session.handle), undefined);
});

test("revokes a replaced capability and removes it even when provider logout fails", async () => {
  const f = sessionFixture();
  const first = await f.service.signIn(credentials);
  f.provider.revoke = async () => {
    throw new AuthenticationFailure("unavailable");
  };
  const next = await f.service.signIn(credentials, first.handle);
  assert.notEqual(next.handle, first.handle);
  assert.equal(await f.service.resolve(first.handle), undefined);
  await f.service.signOut(next.handle);
  assert.equal(f.records.size, 0);
});

test("expires idle sessions and caps active sessions at the absolute lifetime", async () => {
  const idle = sessionFixture();
  const a = await idle.service.signIn(credentials);
  idle.advance(31 * 60_000);
  assert.equal(await idle.service.resolve(a.handle), undefined);
  assert.equal(idle.records.size, 0);
  const active = sessionFixture();
  const b = await active.service.signIn(credentials);
  for (
    let elapsed = 0;
    elapsed < sessionLifetimeMs - 60_000;
    elapsed += 60_000
  ) {
    active.advance(60_000);
    assert.ok(await active.service.resolve(b.handle));
  }
  active.advance(60_000);
  assert.equal(await active.service.resolve(b.handle), undefined);
});

test("fails closed on rejected refreshes, corrupt ciphertext and changed subjects", async () => {
  for (const scenario of ["refresh", "cipher", "subject"]) {
    const f = sessionFixture();
    const session = await f.service.signIn(credentials);
    if (scenario === "refresh")
      f.provider.refresh = async () => {
        throw new AuthenticationFailure("rejected");
      };
    if (scenario === "subject") {
      const original = f.provider.refresh;
      f.provider.refresh = async (token) => ({
        ...(await original(token)),
        profile: { subject: "outsider", displayName: "Outsider" },
      });
    }
    if (scenario === "cipher") {
      const record = [...f.records.values()][0]!;
      f.records.set(record.id, { ...record, encryptedGrant: "tampered" });
    }
    f.advance(40_000);
    assert.equal(await f.service.resolve(session.handle), undefined, scenario);
    assert.equal(f.records.size, 0);
  }
});

test("provider outage keeps the session for retry; rejected passwords are uniform and safe", async () => {
  const f = sessionFixture();
  const session = await f.service.signIn(credentials);
  f.advance(40_000);
  f.provider.refresh = async () => {
    throw new AuthenticationFailure("unavailable");
  };
  await assert.rejects(f.service.resolve(session.handle), {
    code: "SIGN_IN_UNAVAILABLE",
  });
  assert.equal(f.records.size, 1);
  f.provider.authenticate = async () => {
    throw new AuthenticationFailure("rejected");
  };
  await assert.rejects(f.service.signIn(credentials), {
    code: "SIGN_IN_REJECTED",
  });
});
