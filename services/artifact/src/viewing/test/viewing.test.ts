import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
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
  type ArtifactProxy,
} from "../adapter/artifact-proxy.js";
import { artifactHostController } from "../controller/artifact-host-controller.js";
import { ViewCookie } from "../handler/view-cookie.js";
import type {
  ViewGrantRepository,
  ViewSessionRepository,
} from "../interface/view-repositories.js";
import type { ViewGrant, ViewSession } from "../model/view-credential.js";
import { StaticSite } from "../service/static-site.js";
import { ViewAccess } from "../service/view-access.js";

/** In-memory view links and sessions with the same one-time and expiry rules as PostgreSQL. */
function memoryCredentials(): {
  grants: ViewGrantRepository;
  sessions: ViewSessionRepository;
} {
  const grants: ViewGrant[] = [];
  const sessions: ViewSession[] = [];
  const now = () => new Date().toISOString();
  return {
    grants: {
      getById: async () => undefined,
      list: async () => [...grants],
      delete: async () => {},
      async create(grant) {
        grants.push({
          ...grant,
          id: String(grants.length),
          createdAt: now(),
          usedAt: null,
        });
      },
      async consume({ tokenHash }) {
        const grant = grants.find(
          (entry) =>
            entry.tokenHash === tokenHash &&
            !entry.usedAt &&
            entry.expiresAt > now(),
        );
        if (!grant) return undefined;
        Object.assign(grant, { usedAt: now() });
        return grant;
      },
      async purge({ expiredBefore }) {
        grants.splice(
          0,
          grants.length,
          ...grants.filter((entry) => entry.expiresAt >= expiredBefore),
        );
      },
    },
    sessions: {
      getById: async () => undefined,
      list: async () => [...sessions],
      delete: async () => {},
      async create(session) {
        sessions.push({
          ...session,
          id: String(sessions.length),
          createdAt: now(),
        });
      },
      async findValid({ tokenHash }) {
        return sessions.find(
          (entry) => entry.tokenHash === tokenHash && entry.expiresAt > now(),
        );
      },
      async purge() {},
    },
  };
}

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
  const { grants, sessions } = memoryCredentials();
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
    "http://localhost:8080/artifacts/open?slug=site&path=%2Fdocs%3Fx%3D1",
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
  assert.match(stopped.body, /This artifact is stopped/);
  assert.equal(
    (await app.inject({ url: "/missing/", headers })).statusCode,
    404,
  );
});
