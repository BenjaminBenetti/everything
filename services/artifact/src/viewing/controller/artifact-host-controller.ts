import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { artifactSlugPattern } from "@everything/artifact-contracts";
import {
  publicArtifacts,
  type ArtifactRepository,
} from "../../artifact/interface/artifact-repository.js";
import type { AppApiKeys } from "../../capability/service/app-api-keys.js";
import { presentedApiKey } from "../handler/api-key-credentials.js";
import type { ViewCookie } from "../handler/view-cookie.js";
import type { ViewPassCredentials } from "../handler/view-pass-credentials.js";
import {
  viewPassSignInPath,
  type ArtifactViewer,
} from "../model/view-credential.js";
import { apiKeyRejection, hostMessages } from "../presenter/host-pages.js";
import {
  explain,
  serveArtifact,
  type ArtifactServingDependencies,
} from "../service/artifact-serving.js";
import type { ViewAccess } from "../service/view-access.js";
import type { ViewPasses } from "../service/view-passes.js";

/**
 * What the artifact host needs to sign owners, teammates, and API callers in and serve their apps.
 * This host is credential-bearing: public apps are served to anyone by the separate public apps
 * host, so a public app's pages never run on this origin beside a signed-in cookie.
 */
export interface ArtifactHostDependencies extends ArtifactServingDependencies {
  readonly access: Pick<ViewAccess, "redeem" | "viewer">;
  readonly cookie: ViewCookie;
  readonly passes: Pick<ViewPasses, "find">;
  readonly passCredentials: ViewPassCredentials;
  readonly apiKeys: Pick<AppApiKeys, "authenticate">;
  readonly artifacts: Pick<ArtifactRepository, "findBySlug" | "getById">;
  /** This host's own origin, against which the cross-origin guard matches same-origin requests. */
  readonly artifactOrigin: string;
  /** Origin of the Everything application, where signed-out viewers go to sign in. */
  readonly publicOrigin: string;
  /** Origin that serves public apps to anyone; anonymous visitors of a public app go there. */
  readonly publicAppsOrigin: string;
}

/** Accepted slugs in artifact paths. */
const slugPattern = new RegExp(artifactSlugPattern);

/** Owner and teammate pages explain an app that isn't published or is stopped in their own words. */
const ownerMessages = {
  unpublished: hostMessages.unpublished,
  stopped: hostMessages.stopped,
} as const;

/**
 * Sign-in links are the host's only unauthenticated operations that touch storage, so only they are
 * rate limited; signed-in viewers browse artifacts without limits.
 */
const signInLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

/** Methods that cannot change state, so they need no cross-origin protection. */
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether the request is a browser navigation that can follow a redirect to another origin. */
function isNavigation(request: FastifyRequest): boolean {
  if (request.method !== "GET") return false;
  const mode = request.headers["sec-fetch-mode"];
  return mode
    ? mode === "navigate"
    : (request.headers.accept ?? "").includes("text/html");
}

/**
 * Whether an ambient-cookie request may change state. A session or pass cookie is sent automatically
 * by the browser, so a page on any other origin — including a public app — could use it to drive a
 * state-changing request to a private app. The browser sets Sec-Fetch-Site to the initiator's
 * relationship to this origin and forbids pages from setting it, so requiring same-origin blocks
 * every cross-origin initiator without inspecting paths. Browsers without Fetch Metadata fall back
 * to an Origin check against this host.
 */
function sameOriginOrSafe(
  request: FastifyRequest,
  artifactOrigin: string,
): boolean {
  if (safeMethods.has(request.method)) return true;
  const site = request.headers["sec-fetch-site"];
  if (typeof site === "string")
    return site === "same-origin" || site === "none";
  const origin = request.headers.origin;
  return origin === undefined || origin === artifactOrigin;
}

/**
 * Register the artifact host: sign-in links for owners and teammates, API keys for external callers,
 * static files, and forwarding to dynamic apps. Only owners, teammate passes, and API keys are
 * served here; anonymous visitors of a public app are redirected to the public apps host.
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
    apiKeys,
    artifacts,
    artifactOrigin,
    publicOrigin,
    publicAppsOrigin,
  } = dependencies;

  /** Who the request views apps as: the signed-in owner, or else the teammate whose pass it sends. */
  async function viewer(
    request: FastifyRequest,
    passToken: string | undefined,
  ): Promise<ArtifactViewer | undefined> {
    const ownerId = await access.viewer(cookie.read(request));
    if (ownerId) return { ownerId, artifactId: null };
    const pass = await passes.find(passToken);
    return pass && { ownerId: pass.ownerId, artifactId: pass.artifactId };
  }

  /** The app an API key opens, limited to that app like a teammate pass. */
  async function keyViewer(
    slug: string,
    key: string,
  ): Promise<ArtifactViewer | undefined> {
    const scope = await apiKeys.authenticate(slug, key);
    return scope && { ownerId: scope.ownerId, artifactId: scope.artifactId };
  }

  /** Send a signed-out viewer through the application to get a view link for this private app. */
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
    // A request with an API key is judged by that key alone, never by cookies or passes.
    const apiKey = presentedApiKey(request);
    const passToken = passCredentials.read(request);
    // Ambient session or pass cookies must not drive a cross-origin state change against a private app.
    if (
      apiKey === undefined &&
      (cookie.read(request) !== undefined || passToken !== undefined) &&
      !sameOriginOrSafe(request, artifactOrigin)
    )
      return explain(reply, 403, hostMessages.crossOrigin);
    const signedIn =
      apiKey === undefined
        ? await viewer(request, passToken)
        : await keyViewer(slug, apiKey);
    if (!signedIn)
      return apiKey !== undefined
        ? reply
            .code(401)
            .header("Cache-Control", "no-store")
            .send(apiKeyRejection)
        : await anonymous(request, reply, slug, rawPath, query, passToken);
    const own = await artifacts.findBySlug({ ownerId: signedIn.ownerId }, slug);
    // A pass for another app, and a missing app, look the same: not found.
    if (
      !own ||
      (signedIn.artifactId !== null && signedIn.artifactId !== own.id)
    )
      return explain(reply, 404, hostMessages.notFound);
    // The owner's broad session must not run a public app's pages beside their private apps. Public
    // apps open on the public origin for the owner too; only a pass (scoped to one app) and an API
    // key (judged alone, answering a caller rather than a browser) are served here when public.
    if (
      apiKey === undefined &&
      signedIn.artifactId === null &&
      own.visibility === "public"
    )
      return toPublicOrigin(request, reply, slug, rawPath, query);
    return serveArtifact(
      request,
      reply,
      own,
      rawPath,
      query,
      dependencies,
      ownerMessages,
    );
  });

  /** Send a browser to this app on the public origin, where public apps run isolated from private ones. */
  function toPublicOrigin(
    request: FastifyRequest,
    reply: FastifyReply,
    slug: string,
    rawPath: string,
    query: string,
  ): FastifyReply {
    if (!isNavigation(request))
      return explain(reply, 404, hostMessages.notFound);
    return reply
      .header("Cache-Control", "no-store")
      .redirect(
        new URL(`/${slug}${rawPath}${query}`, publicAppsOrigin).toString(),
        302,
      );
  }

  /** A request with no owner, pass, or key: point a public app's visitor at the public apps host. */
  async function anonymous(
    request: FastifyRequest,
    reply: FastifyReply,
    slug: string,
    rawPath: string,
    query: string,
    passToken: string | undefined,
  ): Promise<FastifyReply> {
    const pub = await artifacts.findBySlug(publicArtifacts, slug);
    if (pub && isNavigation(request))
      return toPublicOrigin(request, reply, slug, rawPath, query);
    if (passToken) return explain(reply, 401, hostMessages.passExpired);
    return signIn(request, reply, slug, rawPath + query);
  }
}
