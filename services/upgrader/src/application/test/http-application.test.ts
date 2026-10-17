import assert from "node:assert/strict";
import { test } from "node:test";
import type { UpgradeStatus } from "@everything/upgrade-contracts";
import { UpgradeInProgressError } from "../../upgrade/error/upgrade-errors.js";
import { createHttpApplication } from "../factory/http-application.js";

const status: UpgradeStatus = {
  availability: "ready",
  currentVersion: "0.1.0",
  latestVersion: "0.2.0",
  versionsChecked: true,
  lastUpgrade: null,
};

/** The API with a verifier accepting only "everything" and recorded upgrade requests. */
async function application(context: {
  after: (cleanup: () => Promise<void>) => void;
}) {
  const requested: string[] = [];
  const app = await createHttpApplication({
    verifier: {
      verify: async (token) => {
        if (token !== "everything") throw new Error("rejected");
        return { subject: "system:serviceaccount:everything:everything" };
      },
    },
    upgrades: {
      status: async () => status,
      start: async ({ version }) => {
        if (version === "0.3.0") throw new UpgradeInProgressError();
        requested.push(version);
        return status;
      },
    },
  });
  context.after(() => app.close());
  return { app, requested };
}

const caller = { authorization: "Bearer everything" };

test("only Everything's token reaches the upgrade routes; probes stay open", async (context) => {
  const { app, requested } = await application(context);
  assert.equal((await app.inject({ url: "/health/ready" })).statusCode, 200);
  for (const headers of [{}, { authorization: "Bearer teammate" }]) {
    assert.equal(
      (await app.inject({ url: "/v1/upgrade", headers })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/upgrade",
          headers,
          payload: { version: "0.2.0" },
        })
      ).statusCode,
      401,
    );
  }
  assert.deepEqual(requested, []);
});

test("reports status and starts upgrades to well-formed versions", async (context) => {
  const { app, requested } = await application(context);
  const read = await app.inject({ url: "/v1/upgrade", headers: caller });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), status);
  const started = await app.inject({
    method: "POST",
    url: "/v1/upgrade",
    headers: caller,
    payload: { version: "0.2.0" },
  });
  assert.equal(started.statusCode, 202);
  const conflict = await app.inject({
    method: "POST",
    url: "/v1/upgrade",
    headers: caller,
    payload: { version: "0.3.0" },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "UPGRADE_IN_PROGRESS");
  for (const payload of [
    {},
    { version: "v0.2.0" },
    { version: "0.2.0 --set x=y" },
    { version: "latest" },
    { version: "0.2.0", chart: "oci://elsewhere.test/x" },
  ])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/upgrade",
          headers: caller,
          payload,
        })
      ).statusCode,
      400,
      JSON.stringify(payload),
    );
  assert.deepEqual(requested, ["0.2.0"]);
});
