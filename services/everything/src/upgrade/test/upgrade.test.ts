import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { UpgradeStatus } from "@everything/upgrade-contracts";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { HttpUpgrader } from "../adapter/http-upgrader.js";
import { ProjectedTokenSource } from "../adapter/projected-token-source.js";
import { UnavailableUpgrades } from "../adapter/unavailable-upgrades.js";
import { upgradeController } from "../controller/upgrade-controller.js";
import { UpgradeInProgressError } from "../error/upgrade-errors.js";

const status: UpgradeStatus = {
  availability: "ready",
  currentVersion: "0.1.0-rc7",
  latestVersion: "0.1.0-rc8",
  versionsChecked: true,
  lastUpgrade: null,
};

/** An upgrader answering with a fixed response, recording each request. */
function upgrader(answer: () => Response | Promise<Response>) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return {
    requests,
    client: new HttpUpgrader(
      "http://upgrader:8080",
      { token: async () => "projected" },
      fetcher,
    ),
  };
}

/** A JSON response. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("calls the upgrader with Everything's service account token", async () => {
  const { client, requests } = upgrader(() => json(status));
  assert.deepEqual(await client.status(), status);
  await client.start({ version: "0.1.0-rc8" });
  assert.equal(requests[0]!.url, "http://upgrader:8080/v1/upgrade");
  assert.equal(
    new Headers(requests[0]!.init.headers).get("authorization"),
    "Bearer projected",
  );
  assert.equal(requests[0]!.init.redirect, "error");
  assert.equal(requests[1]!.init.method, "POST");
  assert.equal(
    requests[1]!.init.body,
    JSON.stringify({ version: "0.1.0-rc8" }),
  );
});

test("turns the upgrader's refusals into Everything's errors, and anything else into unavailable", async () => {
  const cases: [Response | Error, string][] = [
    [
      json({ code: "UPGRADE_IN_PROGRESS", message: "x" }, 409),
      "UPGRADE_IN_PROGRESS",
    ],
    [
      json({ code: "UPGRADE_VERSION_UNAVAILABLE", message: "x" }, 409),
      "UPGRADE_VERSION_UNAVAILABLE",
    ],
    [
      json(
        {
          code: "UPGRADE_SETTINGS_MISSING",
          message: "Run the installer once more.",
        },
        409,
      ),
      "UPGRADES_OFF",
    ],
    [
      json(
        { code: "UPGRADES_NOT_CONFIGURED", message: "Use the installer." },
        409,
      ),
      "UPGRADES_OFF",
    ],
    [
      json({ code: "CHART_REGISTRY_UNAVAILABLE", message: "x" }, 503),
      "UPGRADES_UNAVAILABLE",
    ],
    [
      json({ code: "UNAUTHENTICATED", message: "x" }, 401),
      "UPGRADES_UNAVAILABLE",
    ],
    [
      new Response("<html>bad gateway</html>", { status: 502 }),
      "UPGRADES_UNAVAILABLE",
    ],
    [new Error("connection refused"), "UPGRADES_UNAVAILABLE"],
  ];
  for (const [answer, code] of cases) {
    const { client } = upgrader(() => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    await assert.rejects(
      client.start({ version: "0.1.0-rc8" }),
      { code },
      code,
    );
  }
  const { client } = upgrader(() =>
    json(
      {
        code: "UPGRADE_SETTINGS_MISSING",
        message: "Run the installer once more.",
      },
      409,
    ),
  );
  await assert.rejects(client.start({ version: "0.1.0-rc8" }), {
    message: "Run the installer once more.",
  });
  await assert.rejects(new UnavailableUpgrades().status(), {
    code: "UPGRADES_UNAVAILABLE",
  });
});

test("reads the token the kubelet last wrote to the projected volume", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "projected-token-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "token");
  const source = new ProjectedTokenSource(file);
  await writeFile(file, "first\n");
  assert.equal(await source.token(), "first");
  await writeFile(file, "renewed");
  assert.equal(await source.token(), "renewed");
  await writeFile(file, "");
  await assert.rejects(source.token());
});

test("serves the status and starts upgrades only to well-formed versions", async (context) => {
  const requested: string[] = [];
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await upgradeController(app, {
    status: async () => status,
    start: async ({ version }) => {
      if (version === "0.1.0-rc9") throw new UpgradeInProgressError();
      requested.push(version);
      return { ...status, lastUpgrade: null };
    },
  });
  assert.deepEqual((await app.inject({ url: "/upgrade" })).json(), status);
  const started = await app.inject({
    method: "POST",
    url: "/upgrade",
    payload: { version: "0.1.0-rc8" },
  });
  assert.equal(started.statusCode, 202);
  const conflict = await app.inject({
    method: "POST",
    url: "/upgrade",
    payload: { version: "0.1.0-rc9" },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "UPGRADE_IN_PROGRESS");
  for (const payload of [
    {},
    { version: "latest" },
    { version: "0.1.0-rc8", force: true },
  ])
    assert.equal(
      (await app.inject({ method: "POST", url: "/upgrade", payload }))
        .statusCode,
      400,
      JSON.stringify(payload),
    );
  assert.deepEqual(requested, ["0.1.0-rc8"]);
});
