import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { test, type TestContext } from "node:test";
import { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import { ArtifactLock } from "../../artifact/service/artifact-lock.js";
import { ArtifactVisibilityService } from "../../artifact/service/artifact-visibility-service.js";
import {
  ada,
  file,
  MemoryArtifacts,
  MemoryRevisions,
  owner,
} from "../../artifact/test/artifact-fixture.js";
import { createPublicApplication } from "../../application/factory/public-application.js";
import { ViewCookie } from "../handler/view-cookie.js";
import { ViewPassCredentials } from "../handler/view-pass-credentials.js";
import { StaticSite } from "../service/static-site.js";
import { ViewAccess } from "../service/view-access.js";
import { ViewPasses } from "../service/view-passes.js";
import { memoryCredentials } from "./view-fixture.js";

/** Requests a browser navigation makes, so signed-out private requests redirect to sign in. */
const navigation = { "sec-fetch-mode": "navigate" };

/** One request, sent exactly as written: no client adds fetch metadata, cookies, or redirects. */
interface Visit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** A response read whole, with the parts these tests check. */
interface Visited {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Send a raw HTTP request to the host and read its whole response. */
function send(url: string, visit: Visit): Promise<Visited> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: visit.method ?? "GET", headers: visit.headers ?? {} },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          resolve({
            status: response.statusCode ?? 0,
            headers: {
              get: (name) => {
                const value = response.headers[name.toLowerCase()];
                return value === undefined
                  ? null
                  : Array.isArray(value)
                    ? value.join(", ")
                    : value;
              },
            },
            text: async () => body,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(visit.body);
  });
}

/** The real artifact host on a local port, with public and private apps of two owners. */
async function publicHost(context: TestContext) {
  const artifacts = new MemoryArtifacts();
  const revisions = new MemoryRevisions();
  const files = {
    "index.html": "<h1>Public page</h1>",
    "assets/app.js": "console.log('public');",
  };
  const site = artifacts.add("static", "site", { liveRevision: 1 });
  const hidden = artifacts.add("static", "hidden", { liveRevision: 1 });
  const service = artifacts.add("dynamic", "service", {
    liveDeployment: 1,
    running: true,
  });
  const theirs = artifacts.add("static", "theirs", {
    ownerId: "another-owner",
    liveRevision: 1,
  });
  for (const app of [site, hidden, theirs])
    await revisions.create(
      { ownerId: app.ownerId, artifactId: app.id },
      {
        number: 1,
        author: ada,
        files: Object.entries(files).map(([path, body]) =>
          file(path, body.length),
        ),
        totalSize: 40,
      },
    );
  const lookup = new ArtifactLookup(artifacts);
  const visibility = new ArtifactVisibilityService(
    artifacts,
    lookup,
    new ArtifactLock(),
  );
  /** Change an app's visibility as its owner does from Apps. */
  const share = (slug: string, choice: "public" | "private", by = owner) =>
    visibility.change(by, { id: by, name: "You" }, slug, choice);
  const { grants, sessions, passes: passRecords } = memoryCredentials();
  const passes = new ViewPasses(lookup, passRecords);
  const access = new ViewAccess(
    artifacts,
    grants,
    sessions,
    "http://localhost:8081",
  );
  const forwarded: {
    slug: string;
    path: string;
    method: string;
    cookie?: string;
  }[] = [];
  const host = await createPublicApplication({
    access,
    cookie: new ViewCookie("http://localhost:8081"),
    passes,
    passCredentials: new ViewPassCredentials(),
    apiKeys: { authenticate: async () => undefined },
    artifacts,
    site: new StaticSite(revisions),
    content: {
      /** Serve each fixture file's body by the hash the fixture derived from its path. */
      open: async (hash) =>
        Readable.from([
          Object.entries(files).find(
            ([path, body]) => file(path, body.length).sha256 === hash,
          )?.[1] ?? "",
        ]),
    },
    proxy: {
      /** Record what reaches the dynamic app instead of opening a cluster connection. */
      forward: async (request, reply, artifact, path) => {
        forwarded.push({
          slug: artifact.slug,
          path,
          method: request.method,
          ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
        });
        return reply.send("from the app");
      },
    },
    publicOrigin: "http://localhost:8080",
  });
  await host.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => host.close());
  const origin = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`;
  /** Fetch from the host over HTTP as a browser without cookies would, unless headers add some. */
  const visit = (path: string, init: Visit = {}) => send(origin + path, init);
  /** Sign a browser in to the artifact host as an owner, as a view link does. */
  async function session(ownerId: string, slug: string): Promise<string> {
    const view = await access.grant(ownerId, { slug });
    const code = new URL(view.url).searchParams.get("code")!;
    return (await access.redeem(code))!.sessionToken;
  }
  return {
    artifacts,
    access,
    passes,
    share,
    visit,
    session,
    forwarded,
    site,
    service,
    theirs,
  };
}

test("anonymous visitors get a public static app and its nested files, and nothing private", async (context) => {
  const { visit, share } = await publicHost(context);
  // Before the owner chooses, the app is private and answers exactly like a missing one.
  for (const path of ["/site/", "/missing/"]) {
    const page = await visit(path, { headers: navigation });
    assert.equal(page.status, 302, path);
    assert.match(page.headers.get("location")!, /\/apps\/open\?slug=/);
    assert.equal((await visit(path)).status, 401, path);
  }

  await share("site", "public");
  const page = await visit("/site/");
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<h1>Public page</h1>");
  assert.equal(page.headers.get("cache-control"), "no-cache");
  assert.equal(page.headers.get("set-cookie"), null);
  const asset = await visit("/site/assets/app.js");
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "console.log('public');");
  assert.equal(
    (await visit("/site/assets/app.js", { method: "HEAD" })).status,
    200,
  );
  assert.equal((await visit("/site/", { method: "POST" })).status, 405);
  assert.equal((await visit("/site/missing.png")).status, 404);
  assert.equal((await visit("/site")).headers.get("location"), "/site/");

  // Nothing else of the owner's opens: other apps, encoded escapes, or other casings of the slug.
  for (const path of [
    "/hidden/",
    "/site/%2e%2e/hidden/index.html",
    "/site/..%2fhidden/index.html",
    "/SITE/",
    "/site%2fhidden/",
  ]) {
    const response = await visit(path);
    assert.ok(
      [401, 404].includes(response.status),
      `${path}: ${response.status}`,
    );
    assert.doesNotMatch(await response.text(), /Public page/, path);
  }
  // The host's own pages stay as they were: no listing, and the root sends people to Everything.
  const root = await visit("/");
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "http://localhost:8080/apps");
  assert.equal((await visit("/_access?code=guess")).status, 403);
});

test("making an app private again refuses the next anonymous request, including cached revalidation", async (context) => {
  const { visit, share } = await publicHost(context);
  await share("site", "public");
  const first = await visit("/site/");
  const etag = first.headers.get("etag")!;
  assert.equal(first.status, 200);
  assert.equal(
    (await visit("/site/", { headers: { "if-none-match": etag } })).status,
    304,
  );

  await share("site", "private");
  for (const headers of [{ "if-none-match": etag }, {}]) {
    const refused = await visit("/site/", { headers });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await refused.text(), /Public page/);
  }
  const navigationRefused = await visit("/site/assets/app.js", {
    headers: navigation,
  });
  assert.equal(navigationRefused.status, 302);
});

test("a public dynamic app forwards every method and upgrade, and explains when it isn't running", async (context) => {
  const { visit, share, forwarded, artifacts, service } =
    await publicHost(context);
  assert.equal((await visit("/service/api/items")).status, 401);
  assert.deepEqual(forwarded, []);

  await share("service", "public");
  const read = await visit("/service/api/items?page=2");
  assert.deepEqual([read.status, await read.text()], [200, "from the app"]);
  const write = await visit("/service/api/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(write.status, 200);
  const upgrade = await visit("/service/socket", {
    headers: { connection: "Upgrade", upgrade: "websocket" },
  });
  assert.equal(upgrade.status, 200);
  assert.deepEqual(
    forwarded.map(({ path, method }) => [method, path]),
    [
      ["GET", "/api/items?page=2"],
      ["POST", "/api/items"],
      ["GET", "/socket"],
    ],
  );

  await artifacts.update({ ownerId: owner }, service.id, {
    running: false,
    updatedBy: ada,
  });
  const stopped = await visit("/service/");
  assert.equal(stopped.status, 503);
  assert.match(
    await stopped.text(),
    /This app isn&#39;t available|This app isn't available/,
  );
  await artifacts.update({ ownerId: owner }, service.id, {
    running: true,
    liveDeployment: null,
    updatedBy: ada,
  });
  assert.equal((await visit("/service/")).status, 503);
  assert.equal(forwarded.length, 3);
});

test("another owner's artifact host session is signed out before a public app runs beside it", async (context) => {
  const { visit, share, session, access } = await publicHost(context);
  await share("theirs", "public", "another-owner");
  const mine = await session(owner, "site");
  const cookie = `everything-artifact-session=${mine}`;
  assert.equal((await visit("/hidden/", { headers: { cookie } })).status, 200);

  // The visitor sees the other owner's public app, and their own session ends with that response.
  const visited = await visit("/theirs/", { headers: { cookie } });
  assert.equal(visited.status, 200);
  assert.match(
    visited.headers.get("set-cookie") ?? "",
    /^everything-artifact-session=;.*Expires=Thu, 01 Jan 1970/,
  );
  assert.equal(await access.viewer(mine), undefined);
  // So the public app's pages cannot reach the visitor's private apps with that session.
  const reused = await visit("/hidden/", { headers: { cookie } });
  assert.equal(reused.status, 401);
  assert.doesNotMatch(await reused.text(), /Public page/);

  // The owner's own public app keeps the owner signed in.
  await share("site", "public");
  const again = await session(owner, "site");
  const own = await visit("/site/", {
    headers: { cookie: `everything-artifact-session=${again}` },
  });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("set-cookie"), null);
  assert.equal(await access.viewer(again), owner);
});

test("a public app does not accept a wrong API key, and passes still open only their own private app", async (context) => {
  const { visit, share, passes } = await publicHost(context);
  await share("service", "public");
  const keyed = await visit("/service/hook", {
    method: "POST",
    headers: { "x-api-key": `everything_app_key_${"x".repeat(43)}` },
  });
  assert.equal(keyed.status, 401);
  assert.equal(JSON.parse(await keyed.text()).code, "INVALID_API_KEY");

  // A teammate's pass for one app opens public apps like anyone, but never the owner's other private apps.
  const pass = await passes.issue(owner, "site", {});
  const authorization = `Bearer ${pass.token}`;
  assert.equal(
    (await visit("/site/", { headers: { authorization } })).status,
    200,
  );
  assert.equal(
    (await visit("/service/", { headers: { authorization } })).status,
    200,
  );
  assert.equal(
    (await visit("/hidden/", { headers: { authorization } })).status,
    404,
  );
});
