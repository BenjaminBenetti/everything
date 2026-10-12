import type { FastifyReply, FastifyRequest } from "fastify";
import type { Artifact } from "../../artifact/model/artifact.js";
import { artifactResourceName } from "../../cluster/model/cluster-names.js";
import { servicePort } from "../../deployment/adapter/workload-manifests.js";
import { hostMessages, hostPage } from "../presenter/host-pages.js";

/** Remove the named cookies from a Cookie header, keeping the artifact's own cookies. */
export function withoutCookies(
  header: string | undefined,
  names: readonly string[],
): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair && !names.includes(pair.split("=")[0]!.trim()));
  return kept.length ? kept.join("; ") : undefined;
}

/** Keep redirects inside the artifact when its app answers with a path from its own root. */
export function prefixedLocation(location: string, slug: string): string {
  const prefix = `/${slug}`;
  if (!location.startsWith("/") || location.startsWith("//")) return location;
  if (location === prefix || location.startsWith(`${prefix}/`)) return location;
  return `${prefix}${location}`;
}

/** Forwards requests on the artifact host to running dynamic artifacts. */
export class ArtifactProxy {
  // ===========================================
  // Construction
  // ===========================================

  /** Reach artifact Services in their namespace, withholding the viewer's login cookies. */
  constructor(
    private readonly namespace: string,
    private readonly privateCookies: readonly string[],
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Forward the request with the slug removed from its path, which the app receives as its base path. */
  forward(
    request: FastifyRequest,
    reply: FastifyReply,
    artifact: Artifact,
    pathAndQuery: string,
  ): FastifyReply {
    const upstream = `http://${artifactResourceName(artifact.id)}.${this.namespace}.svc.cluster.local:${servicePort}`;
    return reply.from(`${upstream}${pathAndQuery}`, {
      rewriteRequestHeaders: (_request, headers) => {
        const { cookie, ...rest } = headers;
        const kept = withoutCookies(
          Array.isArray(cookie) ? cookie.join("; ") : cookie,
          this.privateCookies,
        );
        return {
          ...rest,
          ...(kept ? { cookie: kept } : {}),
          "x-forwarded-prefix": `/${artifact.slug}`,
          "x-forwarded-host": request.headers.host ?? "",
          "x-forwarded-proto": request.protocol,
        };
      },
      rewriteHeaders: (headers) =>
        typeof headers.location === "string"
          ? {
              ...headers,
              location: prefixedLocation(headers.location, artifact.slug),
            }
          : headers,
      onError: (failed) => {
        failed
          .code(502)
          .type("text/html; charset=utf-8")
          .send(
            hostPage(
              hostMessages.unreachable.title,
              hostMessages.unreachable.message,
            ),
          );
      },
    });
  }
}
