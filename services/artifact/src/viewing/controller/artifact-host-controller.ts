import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { lookup as mimeType } from "mime-types";
import {
  artifactSlugPattern,
  type ArtifactFile,
} from "@everything/artifact-contracts";
import type { ArtifactRepository } from "../../artifact/interface/artifact-repository.js";
import type { ContentStore } from "../../content/interface/content-store.js";
import type { ArtifactProxy } from "../adapter/artifact-proxy.js";
import type { ViewCookie } from "../handler/view-cookie.js";
import type { ViewPassCredentials } from "../handler/view-pass-credentials.js";
import {
  viewPassSignInPath,
  type ArtifactViewer,
} from "../model/view-credential.js";
import { hostMessages, hostPage } from "../presenter/host-pages.js";
import type { StaticSite } from "../service/static-site.js";
import type { ViewAccess } from "../service/view-access.js";
import type { ViewPasses } from "../service/view-passes.js";

/** What the artifact host needs to sign viewers and teammates in and serve artifacts. */
export interface ArtifactHostDependencies {
  readonly access: Pick<ViewAccess, "redeem" | "viewer">;
  readonly cookie: ViewCookie;
  readonly passes: Pick<ViewPasses, "find">;
  readonly passCredentials: ViewPassCredentials;
  readonly artifacts: Pick<ArtifactRepository, "findBySlug" | "getById">;
  readonly site: StaticSite;
  readonly content: Pick<ContentStore, "open">;
  readonly proxy: Pick<ArtifactProxy, "forward">;
  /** Origin of the Everything application, where signed-out viewers go to sign in. */
  readonly publicOrigin: string;
}

/** Accepted slugs in artifact paths. */
const slugPattern = new RegExp(artifactSlugPattern);

/**
 * Sign-in links are the host's only unauthenticated operations that touch storage, so only they are
 * rate limited; signed-in viewers browse artifacts without limits.
 */
const signInLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

/** Send a short explanatory page. */
function explain(
  reply: FastifyReply,
  status: number,
  page: { readonly title: string; readonly message: string },
): FastifyReply {
  return reply
    .code(status)
    .header("Cache-Control", "no-store")
    .type("text/html; charset=utf-8")
    .send(hostPage(page.title, page.message));
}

/** Whether the request is a browser navigation that can follow a sign-in redirect. */
function isNavigation(request: FastifyRequest): boolean {
  if (request.method !== "GET") return false;
  const mode = request.headers["sec-fetch-mode"];
  return mode
    ? mode === "navigate"
    : (request.headers.accept ?? "").includes("text/html");
}

/**
 * Register the artifact host: sign-in links for users and teammates, static files, and forwarding to
 * dynamic artifacts.
 */
export async function artifactHostController(
  app: FastifyInstance,
  dependencies: ArtifactHostDependencies,
): Promise<void> {
  const {
    access,
    cookie,
    passes,
    passCredentials,
    artifacts,
    site,
    content,
    proxy,
    publicOrigin,
  } = dependencies;

  /** Who the request views artifacts as: the signed-in user, or else the teammate whose pass it sends. */
  async function viewer(
    request: FastifyRequest,
    passToken: string | undefined,
  ): Promise<ArtifactViewer | undefined> {
    const ownerId = await access.viewer(cookie.read(request));
    if (ownerId) return { ownerId, artifactId: null };
    const pass = await passes.find(passToken);
    return pass && { ownerId: pass.ownerId, artifactId: pass.artifactId };
  }

  /** Send a stored file with validators, so unchanged files are not downloaded again. */
  async function sendFile(
    request: FastifyRequest,
    reply: FastifyReply,
    file: ArtifactFile,
    status: number,
  ): Promise<FastifyReply> {
    const etag = `"${file.sha256}"`;
    reply
      .header("ETag", etag)
      .header("Cache-Control", "no-cache")
      .header("X-Content-Type-Options", "nosniff");
    if (status === 200 && request.headers["if-none-match"] === etag)
      return reply.code(304).send();
    reply
      .code(status)
      .type(mimeType(file.path) || "application/octet-stream")
      .header("Content-Length", file.size);
    return request.method === "HEAD"
      ? reply.send()
      : reply.send(await content.open(file.sha256));
  }

  /** Send a signed-out viewer through the application to get a view link for this path. */
  function signIn(
    request: FastifyRequest,
    reply: FastifyReply,
    slug: string,
    pathAndQuery: string,
  ): FastifyReply {
    if (!isNavigation(request))
      return explain(reply, 401, hostMessages.signInRequired);
    const target = new URL("/apps/open", publicOrigin);
    target.searchParams.set("slug", slug);
    target.searchParams.set("path", pathAndQuery);
    return reply
      .header("Cache-Control", "no-store")
      .redirect(target.toString(), 302);
  }

  app.get<{ Querystring: { code?: string } }>(
    "/_access",
    { config: signInLimit },
    async (request, reply) => {
      const code = request.query.code;
      const redeemed =
        typeof code === "string" && code
          ? await access.redeem(code)
          : undefined;
      if (!redeemed) return explain(reply, 403, hostMessages.expiredLink);
      cookie.write(reply, redeemed.sessionToken);
      return reply
        .header("Cache-Control", "no-store")
        .redirect(redeemed.next, 303);
    },
  );

  app.get<{ Querystring: { token?: string } }>(
    viewPassSignInPath,
    { config: signInLimit },
    async (request, reply) => {
      const token =
        typeof request.query.token === "string"
          ? request.query.token
          : undefined;
      const pass = await passes.find(token);
      const artifact =
        pass &&
        (await artifacts.getById({ ownerId: pass.ownerId }, pass.artifactId));
      if (!token || !pass || !artifact)
        return explain(reply, 403, hostMessages.passExpired);
      passCredentials.write(
        request,
        reply,
        { token, expiresAt: pass.expiresAt },
        artifact.slug,
      );
      return reply
        .header("Cache-Control", "no-store")
        .redirect(`/${artifact.slug}${pass.path}`, 303);
    },
  );

  app.get("/", async (_request, reply) =>
    reply.redirect(new URL("/apps", publicOrigin).toString(), 302),
  );

  app.route<{ Params: { slug: string } }>({
    method: ["GET", "HEAD"],
    url: "/:slug",
    handler: async (request, reply) => {
      const query = request.url.includes("?")
        ? request.url.slice(request.url.indexOf("?"))
        : "";
      return reply.redirect(`/${request.params.slug}/${query}`, 308);
    },
  });

  app.all<{ Params: { slug: string } }>("/:slug/*", async (request, reply) => {
    const slug = request.params.slug;
    if (!slugPattern.test(slug))
      return explain(reply, 404, hostMessages.notFound);
    const queryStart = request.url.indexOf("?");
    const rawPath = (
      queryStart === -1 ? request.url : request.url.slice(0, queryStart)
    ).slice(slug.length + 1);
    const query = queryStart === -1 ? "" : request.url.slice(queryStart);
    const passToken = passCredentials.read(request);
    const signedIn = await viewer(request, passToken);
    if (!signedIn)
      return passToken
        ? explain(reply, 401, hostMessages.passExpired)
        : signIn(request, reply, slug, rawPath + query);
    const artifact = await artifacts.findBySlug(
      { ownerId: signedIn.ownerId },
      slug,
    );
    // A pass for another artifact sees the same answer as a missing one.
    if (
      !artifact ||
      (signedIn.artifactId !== null && signedIn.artifactId !== artifact.id)
    )
      return explain(reply, 404, hostMessages.notFound);
    if (artifact.kind === "dynamic") {
      if (artifact.liveDeployment === null)
        return explain(reply, 503, hostMessages.unpublished);
      if (!artifact.running) return explain(reply, 503, hostMessages.stopped);
      return proxy.forward(request, reply, artifact, rawPath + query);
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return reply.code(405).header("Allow", "GET, HEAD").send();
    if (artifact.liveRevision !== null && !artifact.running)
      return explain(reply, 503, hostMessages.stopped);
    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      return explain(reply, 404, hostMessages.notFound);
    }
    const resolution = await site.resolve(artifact, path);
    if (resolution.kind === "redirect")
      return reply.redirect(resolution.location + query, 308);
    if (resolution.kind === "missing")
      return explain(
        reply,
        404,
        artifact.liveRevision === null
          ? hostMessages.unpublished
          : hostMessages.notFound,
      );
    return sendFile(request, reply, resolution.file, resolution.status);
  });
}
