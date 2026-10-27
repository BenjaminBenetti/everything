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
import {
  createPublicApplication,
  createPublicAppsApplication,
} from "../../application/factory/public-application.js";
import { ViewCookie } from "../handler/view-cookie.js";
import { ViewPassCredentials } from "../handler/view-pass-credentials.js";
import type { ArtifactServingDependencies } from "../service/artifact-serving.js";
import { StaticSite } from "../service/static-site.js";
import { ViewAccess } from "../service/view-access.js";
import { ViewPasses } from "../service/view-passes.js";
import { memoryCredentials } from "./view-fixture.js";

const artifactOrigin = "http://localhost:8081";
const publicAppsOrigin = "http://localhost:8082";

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

/** Send a raw HTTP request to a host and read its whole response. */
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

/**
 * Both hosts over real HTTP on their own ports: the artifact host (credentialed) and the public apps
 * host (anonymous), serving public and private apps of two owners through the production factories.
 */
async function hosts(context: TestContext) {
  const artifacts = new MemoryArtifacts();
  const revisions = new MemoryRevisions();
  const files = {
    "index.html": "<h1>Public page</h1>",
    "assets/app.js": "console.log('public');",
  };
  const site = artifacts.add("static", "site", { liveRevision: 1 });
  artifacts.add("static", "hidden", { liveRevision: 1 });
  const service = artifacts.add("dynamic", "service", {
    liveDeployment: 1,
    running: true,
  });
  for (const app of artifacts.records.values())
    if (app.kind === "static")
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
  const access = new ViewAccess(artifacts, grants, sessions, artifactOrigin);
  const staticSite = new StaticSite(revisions);
  const content = {
    /** Serve each fixture file's body by the hash the fixture derived from its path. */
    open: async (hash: string) =>
      Readable.from([
        Object.entries(files).find(
          ([path, body]) => file(path, body.length).sha256 === hash,
        )?.[1] ?? "",
      ]),
  };
  const forwarded: { slug: string; path: string; method: string }[] = [];
  const serving = {
    site: staticSite,
    content,
    proxy: {
      /** Record what reaches the dynamic app instead of opening a cluster connection. */
      forward: async (request, reply, artifact, path) => {
        forwarded.push({ slug: artifact.slug, path, method: request.method });
        return reply.send("from the app");
      },
    } as ArtifactServingDependencies["proxy"],
  } satisfies ArtifactServingDependencies;
  const host = await createPublicApplication({
    ...serving,
    access,
    cookie: new ViewCookie(artifactOrigin),
    passes,
    passCredentials: new ViewPassCredentials(),
    apiKeys: { authenticate: async () => undefined },
    artifacts,
    artifactOrigin,
    publicOrigin: "http://localhost:8080",
    publicAppsOrigin,
  });
  const publicApps = await createPublicAppsApplication({
    ...serving,
    artifacts,
    publicOrigin: "http://localhost:8080",
  });
  await host.listen({ host: "127.0.0.1", port: 0 });
  await publicApps.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => host.close());
  context.after(() => publicApps.close());
  const hostUrl = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`;
  const publicUrl = `http://127.0.0.1:${(publicApps.server.address() as AddressInfo).port}`;
  /** Fetch from the artifact host over HTTP. */
  const visitHost = (path: string, init: Visit = {}) =>
    send(hostUrl + path, init);
  /** Fetch from the public apps host over HTTP. */
  const visitPublic = (path: string, init: Visit = {}) =>
    send(publicUrl + path, init);
  /** Sign a browser in to the artifact host as an owner, as a view link does. */
  async function session(slug: string): Promise<string> {
    const view = await access.grant(owner, { slug });
    const code = new URL(view.url).searchParams.get("code")!;
    return (await access.redeem(code))!.sessionToken;
  }
  return {
    artifacts,
    share,
    visitHost,
    visitPublic,
    session,
    passes,
    forwarded,
    site,
    service,
  };
}

test("the public apps host serves a public static app and its nested files to anyone, and never sets a cookie", async (context) => {
  const { visitPublic, share } = await hosts(context);
  // Before the owner chooses, the app is private and not reachable on the public origin at all.
  assert.equal((await visitPublic("/site/")).status, 404);
  assert.equal(
    (await visitPublic("/site/", { headers: navigation })).status,
    404,
  );

  await share("site", "public");
  const page = await visitPublic("/site/");
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<h1>Public page</h1>");
  assert.equal(page.headers.get("set-cookie"), null);
  const asset = await visitPublic("/site/assets/app.js");
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "console.log('public');");
  assert.equal(
    (await visitPublic("/site/assets/app.js", { method: "HEAD" })).status,
    200,
  );
  assert.equal((await visitPublic("/site/", { method: "POST" })).status, 405);
  assert.equal((await visitPublic("/site")).headers.get("location"), "/site/");

  // Another owner's private app, path traversal, and casing never reach private content here.
  for (const path of ["/hidden/", "/site/%2e%2e/hidden/index.html", "/SITE/"]) {
    const response = await visitPublic(path);
    assert.ok(
      [301, 308, 404].includes(response.status),
      `${path}: ${response.status}`,
    );
    assert.doesNotMatch(await response.text(), /Public page/, path);
  }
});

test("the public apps host ignores cookies and API keys; it never serves private content with them", async (context) => {
  const { visitPublic, share, session } = await hosts(context);
  await share("site", "public");
  // A stolen artifact-host session cookie, replayed on the public origin, opens nothing private.
  const cookie = `everything-artifact-session=${await session("site")}`;
  assert.equal(
    (await visitPublic("/hidden/", { headers: { cookie } })).status,
    404,
  );
  // The owner's own session on the public origin still only sees the public app, as anyone would.
  const withCookie = await visitPublic("/site/", { headers: { cookie } });
  assert.equal(withCookie.status, 200);
  assert.equal(withCookie.headers.get("set-cookie"), null);
  // An API key is not an access path on the public origin.
  assert.equal(
    (
      await visitPublic("/hidden/", {
        headers: { "x-api-key": `everything_app_key_${"x".repeat(43)}` },
      })
    ).status,
    404,
  );
});

test("a public dynamic app is forwarded on the public origin, and a stopped one shows a neutral notice", async (context) => {
  const { visitPublic, share, forwarded, artifacts, service } =
    await hosts(context);
  assert.equal((await visitPublic("/service/api/items")).status, 404);
  assert.deepEqual(forwarded, []);

  await share("service", "public");
  const read = await visitPublic("/service/api/items?page=2");
  assert.deepEqual([read.status, await read.text()], [200, "from the app"]);
  const write = await visitPublic("/service/api/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(write.status, 200);
  assert.deepEqual(
    forwarded.map(({ method, path }) => [method, path]),
    [
      ["GET", "/api/items?page=2"],
      ["POST", "/api/items"],
    ],
  );
  await artifacts.update({ ownerId: owner }, service.id, {
    running: false,
    updatedBy: ada,
  });
  const stopped = await visitPublic("/service/");
  assert.equal(stopped.status, 503);
  assert.match(await stopped.text(), /isn.?.?t available/);
});

test("making a public app private again stops the next request on the public origin, including cached revalidation", async (context) => {
  const { visitPublic, share } = await hosts(context);
  await share("site", "public");
  const first = await visitPublic("/site/");
  const etag = first.headers.get("etag")!;
  assert.equal(first.status, 200);
  assert.equal(
    (await visitPublic("/site/", { headers: { "if-none-match": etag } }))
      .status,
    304,
  );
  await share("site", "private");
  for (const headers of [{ "if-none-match": etag }, {}]) {
    const refused = await visitPublic("/site/", { headers });
    assert.equal(refused.status, 404);
    assert.doesNotMatch(await refused.text(), /Public page/);
  }
});

test("the artifact host serves owners only, and sends an anonymous public-app visitor to the public origin", async (context) => {
  const { visitHost, share, session } = await hosts(context);
  await share("site", "public");
  // A signed-out navigation for a public app is redirected to the public origin, never served here.
  const redirect = await visitHost("/site/", { headers: navigation });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), `${publicAppsOrigin}/site/`);
  assert.equal(redirect.headers.get("set-cookie"), null);
  // A signed-out non-navigation gets no content and no redirect it could read cross-origin.
  assert.equal((await visitHost("/site/")).status, 401);
  // A private app signed-out still goes to sign-in, revealing nothing.
  const privateNav = await visitHost("/hidden/", { headers: navigation });
  assert.equal(privateNav.status, 302);
  assert.match(
    privateNav.headers.get("location")!,
    /\/apps\/open\?slug=hidden/,
  );

  // The owner, signed in, opens their own PRIVATE app on the artifact host.
  const cookie = `everything-artifact-session=${await session("hidden")}`;
  const served = await visitHost("/hidden/", { headers: { cookie } });
  assert.equal(served.status, 200);
  assert.equal(await served.text(), "<h1>Public page</h1>");
  // But the owner's broad session never runs a PUBLIC app's pages here: it goes to the public origin,
  // so a public app (which may hold agent-written code) cannot read the owner's private apps.
  const ownerPublic = await visitHost("/site/", {
    headers: { cookie, ...navigation },
  });
  assert.equal(ownerPublic.status, 302);
  assert.equal(
    ownerPublic.headers.get("location"),
    `${publicAppsOrigin}/site/`,
  );
});

test("the artifact host refuses a cross-origin state change that rides the session cookie", async (context) => {
  const { visitHost, session } = await hosts(context);
  const cookie = `everything-artifact-session=${await session("hidden")}`;
  // A same-origin POST from the app's own page is allowed through to the app.
  const sameOrigin = await visitHost("/hidden/save", {
    method: "POST",
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      "content-type": "text/plain",
    },
    body: "x",
  });
  // hidden is static, so POST is 405; the point is it was not blocked as cross-origin (not 403).
  assert.notEqual(sameOrigin.status, 403);
  // A cross-site or same-site-but-cross-origin initiator (e.g. a public app page) is refused.
  for (const site of ["cross-site", "same-site"]) {
    const blocked = await visitHost("/hidden/save", {
      method: "POST",
      headers: { cookie, "sec-fetch-site": site, "content-type": "text/plain" },
      body: "x",
    });
    assert.equal(blocked.status, 403, site);
    assert.match(await blocked.text(), /blocked/i);
  }
  // Safe cross-site reads are not blocked here (the browser's same-origin policy guards the response).
  const read = await visitHost("/hidden/", {
    headers: {
      cookie,
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
    },
  });
  assert.equal(read.status, 200);
});

test("a teammate pass still views a public app on the artifact host, scoped to that one app", async (context) => {
  const { visitHost, share, passes, artifacts } = await hosts(context);
  await share("site", "public");
  const site = (await artifacts.findBySlug({ ownerId: owner }, "site"))!;
  const pass = await passes.issue(owner, "site", {});
  const authorization = `Bearer ${pass.token}`;
  // The pass is scoped to one app, so it carries no cross-app risk and is served here, even public.
  const served = await visitHost("/site/", { headers: { authorization } });
  assert.equal(served.status, 200);
  assert.equal(await served.text(), "<h1>Public page</h1>");
  void site;
  // The same pass opens nothing else.
  assert.equal(
    (await visitHost("/hidden/", { headers: { authorization } })).status,
    404,
  );
});
