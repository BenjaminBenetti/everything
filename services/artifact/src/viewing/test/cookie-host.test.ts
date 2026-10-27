import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestListener,
} from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { test, type TestContext } from "node:test";
import type { FastifyReply } from "fastify";
import { CookieJar } from "tough-cookie";
import { sharesCookieHost } from "@everything/security/cookie-host";
import type { Artifact } from "../../artifact/model/artifact.js";
import { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import {
  MemoryArtifacts,
  MemoryRevisions,
  owner,
} from "../../artifact/test/artifact-fixture.js";
import {
  createPublicApplication,
  createPublicAppsApplication,
} from "../../application/factory/public-application.js";
import { ArtifactProxy } from "../adapter/artifact-proxy.js";
import { ViewCookie } from "../handler/view-cookie.js";
import { ViewPassCredentials } from "../handler/view-pass-credentials.js";
import { AppResponseGuard } from "../service/app-response-guard.js";
import { StaticSite } from "../service/static-site.js";
import { ViewAccess } from "../service/view-access.js";
import { ViewPasses } from "../service/view-passes.js";
import { memoryCredentials } from "./view-fixture.js";

/** The development stack's origins, which the chart renders by default. */
const origins = {
  application: "http://localhost:8080",
  artifact: "http://localhost:8081",
  publicApps: "http://127.0.0.1:8082",
} as const;

/** What a dynamic app's server received. */
interface Received {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
}

/** A dynamic app's server: it records each request and answers with `respond`. */
async function appServer(
  context: TestContext,
  respond: RequestListener,
): Promise<{ port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    received.push({ path: request.url ?? "", headers: request.headers });
    respond(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, received };
}

/** Send one request exactly as given, with no client adding cookies or following redirects. */
function send(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * Both hosts over real HTTP through the production factories and one real ArtifactProxy, composed
 * as the artifact service's composition root does: a private dynamic app, notes, on the artifact
 * host, and a public dynamic app, board, on the public apps host. Only the network destination of
 * each forwarded request is substituted, from the app's cluster Service to its local server.
 */
async function stack(context: TestContext) {
  const artifacts = new MemoryArtifacts();
  const running = { liveDeployment: 1, running: true };
  const notes = artifacts.add("dynamic", "notes", running);
  const board = artifacts.add("dynamic", "board", {
    ...running,
    visibility: "public",
  });
  // The private app keeps its users' state in its own root-path cookies, as many apps do.
  const notesApp = await appServer(context, (_request, response) => {
    response.setHeader("set-cookie", [
      "notes_session=private-notes-state; Path=/; HttpOnly; SameSite=Lax",
      "notes_draft=unsent-private-draft; Path=/",
    ]);
    response.end("private notes");
  });
  // The public app gives each visitor a session of its own.
  const boardApp = await appServer(context, (request, response) => {
    if (!/board_session=/.test(request.headers.cookie ?? ""))
      response.setHeader(
        "set-cookie",
        "board_session=public-visitor-1; Path=/; HttpOnly",
      );
    response.end("public board");
  });
  const servers = new Map([
    [notes.id, notesApp.port],
    [board.id, boardApp.port],
  ]);
  const cookie = new ViewCookie(origins.artifact);
  const passCredentials = new ViewPassCredentials();
  const real = new ArtifactProxy(
    "apps",
    [...cookie.privateCookies, passCredentials.cookieName],
    { read: async () => [] },
    new AppResponseGuard(),
  );
  const proxy = {
    forward(request, reply: FastifyReply, artifact: Artifact, pathAndQuery) {
      const from = reply.from.bind(reply);
      reply.from = (source, options) => {
        const url = new URL(source!);
        assert.ok(url.hostname.endsWith(".apps.svc.cluster.local"));
        return from(
          `http://127.0.0.1:${servers.get(artifact.id)}${url.pathname}${url.search}`,
          options,
        );
      };
      return real.forward(request, reply, artifact, pathAndQuery);
    },
  } satisfies Pick<ArtifactProxy, "forward">;
  const { grants, sessions, passes } = memoryCredentials();
  const access = new ViewAccess(artifacts, grants, sessions, origins.artifact);
  const serving = {
    site: new StaticSite(new MemoryRevisions()),
    content: { open: async () => Readable.from([""]) },
    proxy,
  };
  const host = await createPublicApplication({
    ...serving,
    access,
    cookie,
    passes: new ViewPasses(new ArtifactLookup(artifacts), passes),
    passCredentials,
    apiKeys: { authenticate: async () => assert.fail("no API key is sent") },
    artifacts,
    artifactOrigin: origins.artifact,
    publicOrigin: origins.application,
    publicAppsOrigin: origins.publicApps,
  });
  const publicApps = await createPublicAppsApplication({
    ...serving,
    artifacts,
    publicOrigin: origins.application,
  });
  await host.listen({ host: "127.0.0.1", port: 0 });
  await publicApps.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => host.close());
  context.after(() => publicApps.close());
  // Each origin's Ingress, as a browser reaches it.
  const ingress = new Map<string, number>([
    [origins.artifact, (host.server.address() as AddressInfo).port],
    [origins.publicApps, (publicApps.server.address() as AddressInfo).port],
  ]);
  const jar = new CookieJar();
  /**
   * Visit a page as a browser does: send the cookies its jar holds for the URL, as RFC 6265 matches
   * them by hostname and path, and keep the cookies the response sets.
   */
  async function browse(url: string) {
    const target = new URL(url);
    const port = ingress.get(target.origin);
    assert.ok(port, `an Ingress serves ${target.origin}`);
    const cookies = await jar.getCookieString(url);
    const response = await send(
      `http://127.0.0.1:${port}${target.pathname}${target.search}`,
      {
        host: target.host,
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        ...(cookies ? { cookie: cookies } : {}),
      },
    );
    const set = response.headers["set-cookie"] ?? [];
    for (const value of set) await jar.setCookie(value, url);
    return response;
  }
  return { access, jar, browse, notesApp, boardApp, send, ingress };
}

/** The cookie names in a Cookie header. */
function names(header: string | undefined): string[] {
  return (header ?? "")
    .split(";")
    .map((pair) => pair.split("=")[0]!.trim())
    .filter(Boolean);
}

test("a private app's own root-path cookies stay on the artifact host and never reach a public app's server", async (context) => {
  const { access, jar, browse, notesApp, boardApp } = await stack(context);
  // The owner is signed in to Everything, then opens the private app through a view link.
  await jar.setCookie(
    "everything-session=ui-session; Path=/; HttpOnly",
    `${origins.application}/`,
  );
  const view = await access.grant(owner, { slug: "notes" });
  const signedIn = await browse(view.url);
  assert.equal(signedIn.status, 303);
  const opened = await browse(`${origins.artifact}/notes/`);
  assert.equal(opened.status, 200);
  assert.equal(opened.body, "private notes");
  // The private app's server never received Everything's or the artifact host's session.
  assert.deepEqual(names(notesApp.received[0]!.headers.cookie), []);
  const privateCookies = ["notes_session", "notes_draft"];
  assert.deepEqual(
    names(await jar.getCookieString(`${origins.artifact}/notes/`)).filter(
      (name) => privateCookies.includes(name),
    ),
    privateCookies,
  );
  // Why a port of its own is not enough: browsers send a hostname's cookies to all its ports, so a
  // public apps host on localhost:8082 would receive the private app's cookies, which the proxy
  // forwards because they are not the platform's. The artifact service refuses that layout.
  assert.ok(sharesCookieHost(origins.artifact, "http://localhost:8082"));
  assert.ok(
    names(await jar.getCookieString("http://localhost:8082/board/")).includes(
      "notes_session",
    ),
  );

  // The same browser opens the public app on the public apps host, a hostname of its own.
  assert.ok(!sharesCookieHost(origins.artifact, origins.publicApps));
  assert.ok(!sharesCookieHost(origins.application, origins.publicApps));
  const firstVisit = await browse(`${origins.publicApps}/board/`);
  assert.equal(firstVisit.status, 200);
  assert.equal(firstVisit.body, "public board");
  assert.equal(boardApp.received.length, 1);
  assert.equal(boardApp.received[0]!.headers.cookie, undefined);
  for (const [name, value] of Object.entries(boardApp.received[0]!.headers))
    assert.ok(
      !/private-notes-state|unsent-private-draft|ui-session/.test(
        String(value),
      ),
      `${name} carries no private cookie`,
    );

  // The public app's own session works as usual, and stays on its own hostname.
  const secondVisit = await browse(`${origins.publicApps}/board/items`);
  assert.equal(secondVisit.status, 200);
  assert.equal(boardApp.received[1]!.path, "/items");
  assert.equal(
    boardApp.received[1]!.headers.cookie,
    "board_session=public-visitor-1",
  );
  await browse(`${origins.artifact}/notes/`);
  assert.deepEqual(names(notesApp.received[1]!.headers.cookie).sort(), [
    "notes_draft",
    "notes_session",
  ]);
});

test("the public apps host forwards a public app's own cookies and Authorization, and strips the platform's credentials", async (context) => {
  const { boardApp, send, ingress } = await stack(context);
  // A browser sends a distinct hostname none of these; the proxy strips them anyway.
  const platformCookies = [
    "everything-artifact-session=artifact-session",
    "__Host-everything-artifact-session=secure-artifact-session",
    "everything-session=ui-session",
    "__Host-everything-session=secure-ui-session",
    "everything-teammate-pass=everything_view_pass-cookie",
  ];
  const response = await send(
    `http://127.0.0.1:${ingress.get(origins.publicApps)}/board/api?page=2`,
    {
      host: new URL(origins.publicApps).host,
      cookie: [
        "board_session=public-visitor-1",
        ...platformCookies,
        "board_theme=dark",
      ].join("; "),
      authorization: "Bearer board-owned-token",
      "x-api-key": "everything_app_key_secret",
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.body, "public board");
  const received = boardApp.received[0]!;
  assert.equal(received.path, "/api?page=2");
  assert.equal(
    received.headers.cookie,
    "board_session=public-visitor-1; board_theme=dark",
  );
  assert.equal(received.headers.authorization, "Bearer board-owned-token");
  assert.equal(received.headers["x-api-key"], undefined);
  assert.equal(received.headers["x-forwarded-prefix"], "/board");
  // A teammate pass in Authorization is the platform's too, and never reaches the app.
  await send(`http://127.0.0.1:${ingress.get(origins.publicApps)}/board/`, {
    host: new URL(origins.publicApps).host,
    authorization: "Bearer everything_view_secret-pass",
  });
  assert.equal(boardApp.received[1]!.headers.authorization, undefined);
  // The app's own cookies reach the visitor, so a public app can start a session.
  const fresh = await send(
    `http://127.0.0.1:${ingress.get(origins.publicApps)}/board/`,
    { host: new URL(origins.publicApps).host },
  );
  assert.deepEqual(fresh.headers["set-cookie"], [
    "board_session=public-visitor-1; Path=/; HttpOnly",
  ]);
});
