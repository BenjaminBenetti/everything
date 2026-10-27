import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestListener,
} from "node:http";
import { connect, type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { TestContext } from "node:test";
import type { FastifyReply } from "fastify";
import { CookieJar } from "tough-cookie";
import type { Artifact } from "../../artifact/model/artifact.js";
import { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
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
import { ArtifactProxy } from "../adapter/artifact-proxy.js";
import { ViewCookie } from "../handler/view-cookie.js";
import { ViewPassCredentials } from "../handler/view-pass-credentials.js";
import type { ArtifactHostDependencies } from "../controller/artifact-host-controller.js";
import { AppResponseGuard } from "../service/app-response-guard.js";
import { StaticSite } from "../service/static-site.js";
import { ViewAccess } from "../service/view-access.js";
import { ViewPasses } from "../service/view-passes.js";
import { memoryCredentials } from "./view-fixture.js";

/** The development stack's origins, which the chart renders by default. */
export const origins = {
  application: "http://localhost:8080",
  artifact: "http://localhost:8081",
  publicApps: "http://127.0.0.1:8082",
} as const;

/** Each host's in-cluster URL, as view_app links name them in the `everything` namespace. */
export const internalUrls = {
  artifact: "http://artifact.everything.svc.cluster.local:8080",
  publicApps: "http://public-apps.everything.svc.cluster.local:8082",
} as const;

/** The cookie hosts each host serves, as the artifact service's configuration gives them. */
export const hostnames = {
  artifact: ["localhost", "artifact.everything.svc.cluster.local"],
  publicApps: ["127.0.0.1", "public-apps.everything.svc.cluster.local"],
} as const;

/** The API key the private dynamic app, notes, accepts. */
export const notesKey = "everything_app_key_notes";

/** What a dynamic app's server received. */
export interface Received {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
}

/** A response read whole. */
export interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/**
 * How many times each step that reads or changes anything ran: app lookups, forwarding to a dynamic
 * app, static file resolution and reads, the owner's session, view links, teammate passes, and API keys.
 */
export type Touches = Record<
  | "lookups"
  | "forwards"
  | "files"
  | "sessions"
  | "viewLinks"
  | "passes"
  | "apiKeys",
  number
>;

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
export function send(
  url: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
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
 * Write a request's exact bytes to a port, for requests no HTTP client sends: no Host header, two of
 * them, or a target that is a full URL. Answers with the status line and body.
 */
export function sendRaw(
  port: number,
  text: string,
): Promise<{ status: number; headers: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(text));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const response = Buffer.concat(chunks).toString();
      const split = response.indexOf("\r\n\r\n");
      resolve({
        status: Number(response.split(" ")[1]),
        headers: response.slice(0, split),
        body: response.slice(split + 4),
      });
    });
  });
}

/**
 * Both hosts over real HTTP through the production factories and one real ArtifactProxy, composed
 * as the artifact service's composition root does: a private dynamic app, notes, and a private static
 * app, drafts, on the artifact host; a public dynamic app, board, and a public static app, guide, on
 * the public apps host. Only the network destination of each forwarded request is substituted, from
 * the app's cluster Service to its local server. Each step a refused request must not reach counts
 * how often it ran.
 */
export async function hostStack(context: TestContext) {
  const artifacts = new MemoryArtifacts();
  const revisions = new MemoryRevisions();
  const running = { liveDeployment: 1, running: true };
  const notes = artifacts.add("dynamic", "notes", running);
  const board = artifacts.add("dynamic", "board", {
    ...running,
    visibility: "public",
  });
  const page = "<h1>Guide</h1>";
  for (const [slug, visibility] of [
    ["guide", "public"],
    ["drafts", "private"],
  ] as const) {
    const app = artifacts.add("static", slug, {
      liveRevision: 1,
      running: true,
      visibility,
    });
    await revisions.create(
      { ownerId: app.ownerId, artifactId: app.id },
      {
        number: 1,
        author: ada,
        files: [file("index.html", page.length)],
        totalSize: page.length,
      },
    );
  }
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
  const touches: Touches = {
    lookups: 0,
    forwards: 0,
    files: 0,
    sessions: 0,
    viewLinks: 0,
    passes: 0,
    apiKeys: 0,
  };
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
      touches.forwards++;
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
  const { grants, sessions, passes: passRecords } = memoryCredentials();
  const access = new ViewAccess(artifacts, grants, sessions, origins.artifact);
  const passes = new ViewPasses(new ArtifactLookup(artifacts), passRecords);
  const site = new StaticSite(revisions);
  const counted: Pick<ArtifactHostDependencies, "artifacts"> = {
    artifacts: {
      findBySlug: (scope, slug) => {
        touches.lookups++;
        return artifacts.findBySlug(scope, slug);
      },
      getById: (scope, id) => {
        touches.lookups++;
        return artifacts.getById(scope, id);
      },
    },
  };
  const serving = {
    site: {
      resolve: (artifact: Artifact, path: string) => {
        touches.files++;
        return site.resolve(artifact, path);
      },
    },
    content: {
      open: async () => {
        touches.files++;
        return Readable.from([page]);
      },
    },
    proxy,
  };
  const host = await createPublicApplication(
    {
      ...serving,
      ...counted,
      access: {
        viewer: (token) => {
          touches.sessions++;
          return access.viewer(token);
        },
        redeem: (code) => {
          touches.viewLinks++;
          return access.redeem(code);
        },
      },
      cookie,
      passes: {
        find: (token) => {
          touches.passes++;
          return passes.find(token);
        },
      },
      passCredentials,
      apiKeys: {
        authenticate: async (slug, key) => {
          touches.apiKeys++;
          return slug === "notes" && key === notesKey
            ? { ownerId: owner, artifactId: notes.id }
            : undefined;
        },
      },
      artifactOrigin: origins.artifact,
      publicOrigin: origins.application,
      publicAppsOrigin: origins.publicApps,
    },
    hostnames.artifact,
  );
  const publicApps = await createPublicAppsApplication(
    { ...serving, ...counted, publicOrigin: origins.application },
    hostnames.publicApps,
  );
  await host.listen({ host: "127.0.0.1", port: 0 });
  await publicApps.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => host.close());
  context.after(() => publicApps.close());
  const ports = {
    artifact: (host.server.address() as AddressInfo).port,
    publicApps: (publicApps.server.address() as AddressInfo).port,
  };
  /**
   * The listener a URL reaches. Locally the Ingresses have no host, as the chart renders them, and
   * cluster:forward forwards each entrypoint's port on 127.0.0.1, which localhost resolves to: the
   * port alone picks the host, whatever the hostname. Inside the cluster, each Service's name does.
   */
  function listener(url: URL): number {
    if (url.hostname.endsWith(".svc.cluster.local")) {
      const service = url.hostname.split(".")[0];
      if (service === "artifact" && url.port === "8080") return ports.artifact;
      if (service === "public-apps" && url.port === "8082")
        return ports.publicApps;
    } else if (url.port === "8081") return ports.artifact;
    else if (url.port === "8082") return ports.publicApps;
    assert.fail(`nothing serves ${url.origin}`);
  }
  const jar = new CookieJar();
  /**
   * Visit a page as a browser does: send the cookies its jar holds for the URL, as RFC 6265 matches
   * them by hostname and path, with the URL's host as the Host header, and keep the cookies the
   * response sets.
   */
  async function browse(url: string, headers: Record<string, string> = {}) {
    const target = new URL(url);
    const cookies = await jar.getCookieString(url);
    const response = await send(
      `http://127.0.0.1:${listener(target)}${target.pathname}${target.search}`,
      {
        host: target.host,
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        ...(cookies ? { cookie: cookies } : {}),
        ...headers,
      },
    );
    const set = response.headers["set-cookie"] ?? [];
    for (const value of set) await jar.setCookie(value, url);
    return response;
  }
  return {
    access,
    passes,
    jar,
    browse,
    notesApp,
    boardApp,
    ports,
    touches,
  };
}

/** The cookie names in a Cookie header. */
export function cookieNames(header: string | undefined): string[] {
  return (header ?? "")
    .split(";")
    .map((pair) => pair.split("=")[0]!.trim())
    .filter(Boolean);
}
