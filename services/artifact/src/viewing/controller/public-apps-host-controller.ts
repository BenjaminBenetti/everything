import type { FastifyInstance } from "fastify";
import { artifactSlugPattern } from "@everything/artifact-contracts";
import {
  publicArtifacts,
  type ArtifactRepository,
} from "../../artifact/interface/artifact-repository.js";
import { hostMessages } from "../presenter/host-pages.js";
import {
  explain,
  serveArtifact,
  type ArtifactServingDependencies,
} from "../service/artifact-serving.js";

/**
 * What the public apps host needs to serve public apps to anyone. It reads no credentials: it has no
 * session, pass, or API-key concept, so this origin never carries a signed-in cookie and a public
 * app's pages cannot reach a private app or the artifact host's stored data.
 */
export interface PublicAppsHostDependencies extends ArtifactServingDependencies {
  readonly artifacts: Pick<ArtifactRepository, "findBySlug">;
  /** Origin of the Everything application, where the bare host points a visitor. */
  readonly publicOrigin: string;
}

/** Accepted slugs in app paths. */
const slugPattern = new RegExp(artifactSlugPattern);

/** A visitor sees the same page whether an app is unpublished or stopped: come back later. */
const visitorMessages = {
  unpublished: hostMessages.unavailable,
  stopped: hostMessages.unavailable,
} as const;

/**
 * Register the public apps host, served on its own origin. It serves only apps the owner has made
 * public, to anyone, with no sign-in, pass, or API key. A private, revoked, or missing app answers
 * identically: not found. Credentials a visitor sends are ignored for access and stripped before the
 * app receives the request, so this origin cannot be used to reach anything private.
 */
export async function publicAppsHostController(
  app: FastifyInstance,
  dependencies: PublicAppsHostDependencies,
): Promise<void> {
  const { artifacts, publicOrigin } = dependencies;

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
    // Only public apps are reachable here; a private, revoked, or missing app is simply not found.
    const artifact = await artifacts.findBySlug(publicArtifacts, slug);
    if (!artifact) return explain(reply, 404, hostMessages.notFound);
    return serveArtifact(
      request,
      reply,
      artifact,
      rawPath,
      query,
      dependencies,
      visitorMessages,
    );
  });
}
