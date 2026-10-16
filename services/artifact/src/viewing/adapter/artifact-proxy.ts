import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Artifact } from "../../artifact/model/artifact.js";
import { artifactResourceName } from "../../cluster/model/cluster-names.js";
import { servicePort } from "../../deployment/adapter/workload-manifests.js";
import { viewPassBearer } from "../handler/view-pass-credentials.js";
import { hostMessages, hostPage } from "../presenter/host-pages.js";
import type { ArtifactResponseSecrets } from "../interface/artifact-response-secrets.js";
import type { AppResponseGuard } from "../service/app-response-guard.js";

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

/** Headers for an artifact's app, without the host's login cookies or a teammate pass in Authorization. */
export function withoutHostCredentials(
  headers: IncomingHttpHeaders,
  privateCookies: readonly string[],
): IncomingHttpHeaders {
  const { cookie, authorization, ...rest } = headers;
  const kept = withoutCookies(
    Array.isArray(cookie) ? cookie.join("; ") : cookie,
    privateCookies,
  );
  return {
    ...rest,
    ...(kept ? { cookie: kept } : {}),
    ...(authorization !== undefined && !viewPassBearer(authorization)
      ? { authorization }
      : {}),
  };
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

  /** Reach artifact Services in their namespace, withholding the viewer's login cookies and passes. */
  constructor(
    private readonly namespace: string,
    private readonly privateCookies: readonly string[],
    private readonly secrets: ArtifactResponseSecrets,
    private readonly guard: Pick<AppResponseGuard, "inspect">,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Forward the request with the slug removed from its path, which the app receives as its base path. */
  async forward(
    request: FastifyRequest,
    reply: FastifyReply,
    artifact: Artifact,
    pathAndQuery: string,
  ): Promise<FastifyReply> {
    let credentials: readonly string[];
    try {
      credentials = await this.secrets.read(artifact);
    } catch {
      return this.block(reply);
    }
    let responseHeaders: IncomingHttpHeaders = {};
    const upstream = `http://${artifactResourceName(artifact.id)}.${this.namespace}.svc.cluster.local:${servicePort}`;
    return reply.from(`${upstream}${pathAndQuery}`, {
      rewriteRequestHeaders: (_request, headers) => {
        const forwarded: IncomingHttpHeaders = {
          ...withoutHostCredentials(headers, this.privateCookies),
          "x-forwarded-prefix": `/${artifact.slug}`,
          "x-forwarded-host": request.headers.host ?? "",
          "x-forwarded-proto": request.protocol,
        };
        if (credentials.length) {
          forwarded["accept-encoding"] = "identity";
          for (const name of [
            "range",
            "if-range",
            "if-none-match",
            "if-modified-since",
          ]) {
            delete forwarded[name];
          }
        }
        return forwarded;
      },
      rewriteHeaders: (headers) => {
        // reply-from normally copies these before onResponse; hold every header until inspected.
        responseHeaders = { ...headers };
        return {};
      },
      onResponse: (_request, _response, upstreamResponse) => {
        void this.respond(
          request,
          reply,
          upstreamResponse.stream,
          responseHeaders,
          artifact,
          credentials,
        ).catch(() => this.block(reply));
      },
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

  // ===========================================
  // Response protection
  // ===========================================

  /** Recheck credentials after the upstream request, covering changes made while it was running. */
  private async respond(
    request: FastifyRequest,
    reply: FastifyReply,
    source: Readable,
    headers: IncomingHttpHeaders,
    artifact: Artifact,
    initialSecrets: readonly string[],
  ): Promise<void> {
    // Canceling an unread undici body emits an error; observe it even before inspection starts.
    source.on("error", () => {});
    /** Cancel upstream reads as soon as the browser disconnects. */
    const cancel = (): void => {
      source.destroy();
    };
    reply.raw.once("close", cancel);
    try {
      const secrets = [
        ...new Set([...initialSecrets, ...(await this.secrets.read(artifact))]),
      ];
      if (reply.raw.destroyed) {
        source.destroy();
        return;
      }
      const response = secrets.length
        ? await this.guard.inspect(
            source,
            headers,
            reply.statusCode,
            request.method,
            secrets,
          )
        : { headers, stream: source };
      if (typeof response.headers.location === "string") {
        response.headers.location = prefixedLocation(
          response.headers.location,
          artifact.slug,
        );
      }
      reply.headers(response.headers).send(response.stream);
    } catch {
      source.destroy();
      this.block(reply);
    }
  }

  /** Send a credential-free error before output starts, or terminate a response already streaming. */
  private block(reply: FastifyReply): FastifyReply {
    reply.request.log.warn("App response blocked by credential protection");
    if (reply.raw.headersSent || reply.sent) {
      reply.raw.destroy();
      return reply;
    }
    for (const name of Object.keys(reply.getHeaders()))
      reply.removeHeader(name);
    return reply
      .code(502)
      .header("Cache-Control", "no-store")
      .type("text/html; charset=utf-8")
      .send(
        hostPage(
          hostMessages.blockedResponse.title,
          hostMessages.blockedResponse.message,
        ),
      );
  }
}
