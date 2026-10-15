import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import {
  ada,
  file,
  MemoryArtifacts,
  MemoryRevisions,
  owner,
} from "../../artifact/test/artifact-fixture.js";
import {
  prefixedLocation,
  withoutCookies,
  withoutHostCredentials,
  type ArtifactProxy,
} from "../adapter/artifact-proxy.js";
import { artifactHostController } from "../controller/artifact-host-controller.js";
import { ViewCookie } from "../handler/view-cookie.js";
import { ViewPassCredentials } from "../handler/view-pass-credentials.js";
import { credentialHash } from "../model/view-credential.js";
import { StaticSite } from "../service/static-site.js";
import { ViewAccess } from "../service/view-access.js";
import { ViewPasses } from "../service/view-passes.js";
import { expire, memoryCredentials } from "./view-fixture.js";

test("static paths serve files, directory indexes, trailing-slash redirects, and 404.html", async () => {
  const artifacts = new MemoryArtifacts();
  const revisions = new MemoryRevisions();
  const site = artifacts.add("static", "site", { liveRevision: 1 });
  await revisions.create(
    { ownerId: owner, artifactId: site.id },
    {
      number: 1,
      author: ada,
      files: [
        file("index.html"),
        file("docs/index.html"),
        file("app.js"),
        file("404.html"),
      ],
      totalSize: 40,
    },
  );
  const resolver = new StaticSite(revisions);
  const resolve = async (path: string) => {
    const result = await resolver.resolve(site, path);
    return result.kind === "file"
      ? `${result.status} ${result.file.path}`
      : result.kind === "redirect"
        ? `redirect ${result.location}`
        : "missing";
  };
  assert.equal(await resolve("/"), "200 index.html");
  assert.equal(await resolve("/app.js"), "200 app.js");
  assert.equal(await resolve("/docs/"), "200 docs/index.html");
  assert.equal(await resolve("/docs"), "redirect /site/docs/");
  assert.equal(await resolve("/nothing.png"), "404 404.html");
  assert.equal(await resolve("/../index.html"), "missing");
  const unpublished = artifacts.add("static", "draft");
  assert.equal((await resolver.resolve(unpublished, "/")).kind, "missing");
});

test("forwarded requests keep the artifact's cookies and keep redirects under its path", () => {
  assert.equal(
    withoutCookies(
      "theme=dark; everything-artifact-session=secret; everything-session=s",
      ["everything-artifact-session", "everything-session"],
    ),
    "theme=dark",
  );
  assert.equal(
    withoutCookies("everything-session=s", ["everything-session"]),
    undefined,
  );
  assert.equal(prefixedLocation("/login", "app"), "/app/login");
  assert.equal(prefixedLocation("/app/login", "app"), "/app/login");
  assert.equal(prefixedLocation("/app", "app"), "/app");
  assert.equal(
    prefixedLocation("https://example.com/", "app"),
    "https://example.com/",
  );
  assert.equal(prefixedLocation("//evil.test/", "app"), "//evil.test/");
  assert.equal(prefixedLocation("next", "app"), "next");
});

test("a view link works once, for an existing artifact, and only for paths inside it", async () => {
  const artifacts = new MemoryArtifacts();
  artifacts.add("static", "site");
  const { grants, sessions } = memoryCredentials();
  const access = new ViewAccess(
    artifacts,
    grants,
    sessions,
    "https://artifacts.test",
  );
  const view = await access.grant(owner, {
    slug: "site",
    path: "/docs/?tab=1",
  });
  const code = new URL(view.url).searchParams.get("code")!;
  assert.ok(view.url.startsWith("https://artifacts.test/_access?code="));
  const redeemed = await access.redeem(code);
  assert.equal(redeemed?.next, "/site/docs/?tab=1");
  assert.equal(await access.viewer(redeemed?.sessionToken), owner);
  assert.equal(await access.redeem(code), undefined);
  assert.equal(await access.viewer("forged"), undefined);
  await assert.rejects(access.grant(owner, { slug: "missing" }), {
    code: "ARTIFACT_NOT_FOUND",
  });
  await assert.rejects(access.grant("someone-else", { slug: "site" }), {
    code: "ARTIFACT_NOT_FOUND",
  });
  for (const path of ["//evil.test/", "no-slash", "/a\\b", "/a b"])
    await assert.rejects(access.grant(owner, { slug: "site", path }), {
      code: "INVALID_VIEW_PATH",
    });
});

test("the artifact host signs viewers in, serves files with validators, and explains stopped apps", async (context) => {
  const artifacts = new MemoryArtifacts();
  const revisions = new MemoryRevisions();
  const site = artifacts.add("static", "site", { liveRevision: 1 });
  artifacts.add("dynamic", "app", { liveDeployment: 1, running: false });
  const page = file("index.html", 5);
  await revisions.create(
    { ownerId: owner, artifactId: site.id },
    { number: 1, author: ada, files: [page], totalSize: 5 },
  );
  const { grants, sessions, passes } = memoryCredentials();
  const access = new ViewAccess(
    artifacts,
    grants,
    sessions,
    "http://localhost:8081",
  );
  const app = Fastify();
  context.after(() => app.close());
  await app.register(fastifyCookie);
  await artifactHostController(app, {
    access,
    cookie: new ViewCookie("http://localhost:8081"),
    passes: new ViewPasses(new ArtifactLookup(artifacts), passes),
    passCredentials: new ViewPassCredentials(),
    artifacts,
    site: new StaticSite(revisions),
    content: { open: async () => Readable.from(["hello"]) },
    proxy: {} as ArtifactProxy,
    publicOrigin: "http://localhost:8080",
  });

  const signedOut = await app.inject({
    url: "/site/docs?x=1",
    headers: { "sec-fetch-mode": "navigate" },
  });
  assert.equal(signedOut.statusCode, 302);
  assert.equal(
    signedOut.headers.location,
    "http://localhost:8080/apps/open?slug=site&path=%2Fdocs%3Fx%3D1",
  );
  assert.equal((await app.inject({ url: "/site/" })).statusCode, 401);

  const view = await access.grant(owner, { slug: "site" });
  const redeemed = await app.inject({
    url: new URL(view.url).pathname + new URL(view.url).search,
  });
  assert.equal(redeemed.statusCode, 303);
  assert.equal(redeemed.headers.location, "/site/");
  const cookie = redeemed.cookies.find(
    (entry) => entry.name === "everything-artifact-session",
  );
  assert.ok(cookie?.httpOnly);
  assert.equal(cookie?.sameSite, "Lax");
  assert.equal(
    (
      await app.inject({
        url: new URL(view.url).pathname + new URL(view.url).search,
      })
    ).statusCode,
    403,
  );

  const headers = { cookie: `everything-artifact-session=${cookie!.value}` };
  const served = await app.inject({ url: "/site/", headers });
  assert.equal(served.statusCode, 200);
  assert.equal(served.body, "hello");
  assert.match(String(served.headers["content-type"]), /text\/html/);
  assert.equal(served.headers.etag, `"${page.sha256}"`);
  const unchanged = await app.inject({
    url: "/site/",
    headers: { ...headers, "if-none-match": `"${page.sha256}"` },
  });
  assert.equal(unchanged.statusCode, 304);
  assert.equal(
    (await app.inject({ method: "POST", url: "/site/", headers })).statusCode,
    405,
  );
  assert.equal(
    (await app.inject({ url: "/site", headers })).headers.location,
    "/site/",
  );
  const stopped = await app.inject({ url: "/app/", headers });
  assert.equal(stopped.statusCode, 503);
  assert.match(stopped.body, /This app is stopped/);
  await artifacts.update({ ownerId: owner }, site.id, {
    running: false,
    updatedBy: ada,
  });
  const pausedPage = await app.inject({
    url: "/site/",
    headers: { ...headers, "if-none-match": `"${page.sha256}"` },
  });
  assert.equal(
    pausedPage.statusCode,
    503,
    "a paused page cannot be reopened through a cached file validator",
  );
  assert.match(pausedPage.body, /This app is stopped/);
  await artifacts.update({ ownerId: owner }, site.id, {
    running: true,
    updatedBy: ada,
  });
  assert.equal((await app.inject({ url: "/site/", headers })).body, "hello");
  assert.equal(
    (await app.inject({ url: "/missing/", headers })).statusCode,
    404,
  );
});

test("forwarded requests drop the host's credentials and keep the artifact's own Authorization", () => {
  const privateCookies = [
    "everything-artifact-session",
    "everything-teammate-pass",
  ];
  const pass = "everything_view_secret";
  assert.deepEqual(
    withoutHostCredentials(
      {
        authorization: `Bearer ${pass}`,
        cookie: `theme=dark; everything-teammate-pass=${pass}`,
        accept: "text/html",
      },
      privateCookies,
    ),
    { cookie: "theme=dark", accept: "text/html" },
  );
  assert.deepEqual(
    withoutHostCredentials(
      {
        authorization: "Bearer app-token",
        cookie: "everything-artifact-session=s",
      },
      privateCookies,
    ),
    { authorization: "Bearer app-token" },
  );
});

test("a teammate pass opens one existing artifact of its owner, is stored hashed, and expires", async () => {
  const artifacts = new MemoryArtifacts();
  const site = artifacts.add("static", "site");
  const { passes: repository, storedPasses } = memoryCredentials();
  const passes = new ViewPasses(new ArtifactLookup(artifacts), repository);

  const issued = await passes.issue(owner, "site", { path: "/docs/?tab=1" });
  assert.match(issued.token, /^everything_view_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.path, "/site/docs/?tab=1");
  assert.equal(issued.signInPath, `/_teammate-access?token=${issued.token}`);
  const lifetime = Date.parse(issued.expiresAt) - Date.now();
  assert.ok(lifetime > 9 * 60_000 && lifetime <= 10 * 60_000);
  assert.deepEqual(
    [storedPasses[0]!.tokenHash, storedPasses[0]!.artifactId],
    [credentialHash(issued.token), site.id],
  );
  assert.ok(!JSON.stringify(storedPasses).includes(issued.token));
  assert.equal((await passes.find(issued.token))?.ownerId, owner);
  assert.equal((await passes.issue(owner, site.id, {})).path, "/site/");

  for (const token of [undefined, "", "forged", "everything_view_forged"])
    assert.equal(await passes.find(token), undefined);
  for (const [ownerId, reference] of [
    [owner, "missing"],
    ["someone-else", "site"],
    ["someone-else", site.id],
  ] as const)
    await assert.rejects(passes.issue(ownerId, reference, {}), {
      code: "ARTIFACT_NOT_FOUND",
    });
  for (const path of ["//evil.test/", "no-slash", "/a\\b", "/a b"])
    await assert.rejects(passes.issue(owner, "site", { path }), {
      code: "INVALID_VIEW_PATH",
    });

  expire(storedPasses[0]!);
  assert.equal(await passes.find(issued.token), undefined);
  await passes.purge();
  assert.equal(storedPasses.length, 1, "only the expired pass is purged");
});

/** The artifact host with a static site, a running and a stopped app, and a recording proxy. */
async function teammateHost(context: {
  after: (cleanup: () => unknown) => void;
}) {
  const artifacts = new MemoryArtifacts();
  const revisions = new MemoryRevisions();
  const site = artifacts.add("static", "site", { liveRevision: 1 });
  artifacts.add("dynamic", "app", { liveDeployment: 1, running: true });
  const foreign = artifacts.add("static", "foreign", {
    ownerId: "someone-else",
    liveRevision: 1,
  });
  for (const artifact of [site, foreign])
    await revisions.create(
      { ownerId: artifact.ownerId, artifactId: artifact.id },
      { number: 1, author: ada, files: [file("index.html", 5)], totalSize: 5 },
    );
  const {
    grants,
    sessions,
    passes: repository,
    storedPasses,
  } = memoryCredentials();
  const passes = new ViewPasses(new ArtifactLookup(artifacts), repository);
  const forwarded: { slug: string; path: string }[] = [];
  const host = Fastify({ trustProxy: true });
  context.after(() => host.close());
  await host.register(fastifyCookie);
  await artifactHostController(host, {
    access: new ViewAccess(
      artifacts,
      grants,
      sessions,
      "http://localhost:8081",
    ),
    cookie: new ViewCookie("http://localhost:8081"),
    passes,
    passCredentials: new ViewPassCredentials(),
    artifacts,
    site: new StaticSite(revisions),
    content: { open: async () => Readable.from(["hello"]) },
    proxy: {
      forward: (_request, reply, artifact, path) => {
        forwarded.push({ slug: artifact.slug, path });
        return reply.send("from the app");
      },
    } as ArtifactProxy,
    publicOrigin: "http://localhost:8080",
  });
  return { host, passes, storedPasses, forwarded };
}

test("a teammate pass views its static or dynamic artifact as a bearer token, and nothing else", async (context) => {
  const { host, passes, storedPasses, forwarded } = await teammateHost(context);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const sitePass = await passes.issue(owner, "site", {});
  const served = await host.inject({
    url: "/site/",
    headers: bearer(sitePass.token),
  });
  assert.deepEqual([served.statusCode, served.body], [200, "hello"]);
  for (const url of ["/app/", "/foreign/", "/missing/"]) {
    const refused = await host.inject({ url, headers: bearer(sitePass.token) });
    assert.equal(refused.statusCode, 404, url);
    assert.match(refused.body, /App not found/);
  }

  const appPass = await passes.issue(owner, "app", {});
  const proxied = await host.inject({
    method: "POST",
    url: "/app/api/items?limit=2",
    headers: { ...bearer(appPass.token), "content-type": "application/json" },
    payload: "{}",
  });
  assert.equal(proxied.body, "from the app");
  assert.deepEqual(forwarded, [{ slug: "app", path: "/api/items?limit=2" }]);

  const forged = await host.inject({
    url: "/site/",
    headers: bearer("everything_view_forged"),
  });
  assert.equal(forged.statusCode, 401);
  assert.match(forged.body, /teammate link has expired/);
  expire(storedPasses[0]!);
  assert.equal(
    (await host.inject({ url: "/site/", headers: bearer(sitePass.token) }))
      .statusCode,
    401,
  );
  for (const headers of [
    bearer("app-token"),
    { cookie: "everything-teammate-pass=set-by-an-app" },
  ]) {
    const notAPass = await host.inject({ url: "/site/", headers });
    assert.match(notAPass.body, /Sign in to view this app/);
  }
});

test("a teammate's browser link stores the pass in a cookie over plain HTTP and opens the page", async (context) => {
  const { host, passes, forwarded } = await teammateHost(context);
  const pass = await passes.issue(owner, "app", { path: "/dashboard?x=1" });
  const signedIn = await host.inject({ url: pass.signInPath });
  assert.equal(signedIn.statusCode, 303);
  assert.equal(signedIn.headers.location, "/app/dashboard?x=1");
  const cookie = signedIn.cookies.find(
    (entry) => entry.name === "everything-teammate-pass",
  )!;
  assert.deepEqual(
    [
      cookie.value,
      cookie.path,
      cookie.httpOnly,
      cookie.sameSite,
      cookie.secure,
    ],
    [pass.token, "/app", true, "Lax", undefined],
  );
  assert.ok(cookie.maxAge! > 9 * 60 && cookie.maxAge! <= 10 * 60);
  const reused = await host.inject({ url: pass.signInPath });
  assert.equal(reused.statusCode, 303, "the link works until the pass expires");

  const browsed = await host.inject({
    url: "/app/dashboard?x=1",
    headers: { cookie: `everything-teammate-pass=${cookie.value}` },
  });
  assert.equal(browsed.body, "from the app");
  assert.deepEqual(forwarded, [{ slug: "app", path: "/dashboard?x=1" }]);

  const secure = await host.inject({
    url: pass.signInPath,
    headers: { "x-forwarded-proto": "https" },
  });
  assert.equal(secure.cookies[0]?.secure, true);
  for (const url of [
    "/_teammate-access",
    "/_teammate-access?token=everything_view_forged",
    `/_teammate-access?token=${pass.token}&token=${pass.token}`,
  ]) {
    const refused = await host.inject({ url });
    assert.equal(refused.statusCode, 403, url);
    assert.match(refused.body, /teammate link has expired/);
  }
});
