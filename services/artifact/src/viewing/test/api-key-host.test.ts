import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import {
  MemoryRevisions,
  owner,
} from "../../artifact/test/artifact-fixture.js";
import { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import { apiKeyApps } from "../../capability/test/api-key-fixture.js";
import { newAppApiKey } from "../../capability/model/app-api-key.js";
import { artifactHostController } from "../controller/artifact-host-controller.js";
import { ViewCookie } from "../handler/view-cookie.js";
import { ViewPassCredentials } from "../handler/view-pass-credentials.js";
import { StaticSite } from "../service/static-site.js";
import { ViewAccess } from "../service/view-access.js";
import { ViewPasses } from "../service/view-passes.js";
import { memoryCredentials } from "./view-fixture.js";

/** The artifact host over synthetic apps with keys, recording what reaches each app. */
async function keyHost(context: { after: (cleanup: () => unknown) => void }) {
  const apps = await apiKeyApps();
  const hooks = await apps.deployed("hooks", ["api-key"]);
  await apps.deployed("other", ["api-key"]);
  await apps.deployed("plain", ["everything-api"]);
  await apps.deployed("paused", ["api-key"], { running: false });
  apps.artifacts.add("static", "site", { liveRevision: 1 });
  const { grants, sessions, passes } = memoryCredentials();
  const access = new ViewAccess(
    apps.artifacts,
    grants,
    sessions,
    "http://localhost:8081",
  );
  const forwarded: { slug: string; path: string; method: string }[] = [];
  const host = Fastify();
  context.after(() => host.close());
  await host.register(fastifyCookie);
  await artifactHostController(host, {
    access,
    cookie: new ViewCookie("http://localhost:8081"),
    passes: new ViewPasses(new ArtifactLookup(apps.artifacts), passes),
    passCredentials: new ViewPassCredentials(),
    apiKeys: apps.apiKeys,
    artifacts: apps.artifacts,
    site: new StaticSite(new MemoryRevisions()),
    content: { open: async () => Readable.from(["hello"]) },
    proxy: {
      /** Simulate forwarding while recording the app, method, and unprefixed path. */
      forward: async (request, reply, artifact, path) => {
        forwarded.push({ slug: artifact.slug, path, method: request.method });
        return reply.send("from the app");
      },
    },
    artifactOrigin: "http://localhost:8081",
    publicOrigin: "http://localhost:8080",
    publicAppsOrigin: "http://localhost:8082",
  });
  /** A browser session for the owner, as a view link creates it. */
  async function session(): Promise<string> {
    const view = await access.grant(owner, { slug: "hooks" });
    const code = new URL(view.url).searchParams.get("code")!;
    return `everything-artifact-session=${(await access.redeem(code))!.sessionToken}`;
  }
  return { ...apps, hooks, host, forwarded, session };
}

/** Assert the uniform API key rejection: JSON, uncached, and never a sign-in page. */
function assertRejected(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}): void {
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(String(response.headers["content-type"]), /application\/json/);
  assert.equal(JSON.parse(response.body).code, "INVALID_API_KEY");
  assert.equal(response.headers.location, undefined);
  assert.doesNotMatch(response.body, /<html|everything_app_key_/);
}

test("an app's key in X-Api-Key reaches that app, including upgrade requests", async (context) => {
  const { host, keys, forwarded } = await keyHost(context);
  const key = keys.get("hooks")!;
  const posted = await host.inject({
    method: "POST",
    url: "/hooks/webhook?source=ci",
    headers: { "x-api-key": key, "content-type": "application/json" },
    payload: "{}",
  });
  assert.deepEqual([posted.statusCode, posted.body], [200, "from the app"]);
  const upgraded = await host.inject({
    url: "/hooks/socket",
    headers: {
      "X-Api-Key": key,
      connection: "Upgrade",
      upgrade: "websocket",
    },
  });
  assert.equal(upgraded.statusCode, 200);
  assert.deepEqual(forwarded, [
    { slug: "hooks", path: "/webhook?source=ci", method: "POST" },
    { slug: "hooks", path: "/socket", method: "GET" },
  ]);
  assertRejected(
    await host.inject({
      url: "/hooks/socket",
      headers: {
        "x-api-key": keys.get("other")!,
        connection: "Upgrade",
        upgrade: "websocket",
      },
    }),
  );
});

test("wrong, malformed, repeated, disabled, and revoked keys get the same JSON 401 and reach no app", async (context) => {
  const { host, hooks, keys, forwarded, store } = await keyHost(context);
  const key = keys.get("hooks")!;
  const attempts: [string, string | string[]][] = [
    ["/hooks/", keys.get("other")!],
    ["/other/", key],
    ["/hooks/", newAppApiKey()],
    ["/hooks/", ""],
    ["/hooks/", "secret"],
    ["/hooks/", `Bearer ${key}`],
    ["/hooks/", `${key},${key}`],
    ["/hooks/", [key, key]],
    ["/hooks/", [key, keys.get("other")!]],
    ["/plain/", keys.get("plain")!],
    ["/site/", key],
    ["/missing/", key],
  ];
  for (const [url, value] of attempts)
    assertRejected(await host.inject({ url, headers: { "x-api-key": value } }));
  await store.revoke({ ownerId: owner, artifactId: hooks.id });
  assertRejected(
    await host.inject({ url: "/hooks/", headers: { "x-api-key": key } }),
  );
  assert.deepEqual(forwarded, []);
});

test("a key is accepted only in its header, and a valid key still respects a stopped app", async (context) => {
  const { host, keys, forwarded } = await keyHost(context);
  const key = keys.get("hooks")!;
  for (const request of [
    { url: `/hooks/?api_key=${key}` },
    { url: `/hooks/?x-api-key=${key}` },
    { url: "/hooks/", headers: { authorization: `Bearer ${key}` } },
    { url: "/hooks/", headers: { cookie: `x-api-key=${key}` } },
  ]) {
    const response = await host.inject(request);
    assert.equal(response.statusCode, 401, request.url);
    assert.match(response.body, /Sign in to view this app/);
  }
  const navigation = await host.inject({
    url: `/hooks/?api_key=${key}`,
    headers: { "sec-fetch-mode": "navigate" },
  });
  assert.equal(navigation.statusCode, 302);
  const paused = await host.inject({
    url: "/paused/",
    headers: { "x-api-key": keys.get("paused")! },
  });
  assert.equal(paused.statusCode, 503);
  assert.match(paused.body, /This app is stopped/);
  assert.deepEqual(forwarded, []);
});

test("browser sessions work as before, but a request that sends a key is judged by the key alone", async (context) => {
  const { host, keys, forwarded, session } = await keyHost(context);
  const cookie = await session();
  const viewed = await host.inject({ url: "/hooks/", headers: { cookie } });
  assert.deepEqual([viewed.statusCode, viewed.body], [200, "from the app"]);
  assert.equal(
    (await host.inject({ url: "/plain/", headers: { cookie } })).statusCode,
    200,
  );
  assertRejected(
    await host.inject({
      url: "/hooks/",
      headers: { cookie, "x-api-key": "not-a-key" },
    }),
  );
  const withKey = await host.inject({
    url: "/hooks/",
    headers: { cookie, "x-api-key": keys.get("hooks")! },
  });
  assert.equal(withKey.statusCode, 200);
  assertRejected(
    await host.inject({
      url: "/plain/",
      headers: { cookie, "x-api-key": keys.get("hooks")! },
    }),
  );
  assert.deepEqual(
    forwarded.map((entry) => entry.slug),
    ["hooks", "plain", "hooks"],
  );
});
