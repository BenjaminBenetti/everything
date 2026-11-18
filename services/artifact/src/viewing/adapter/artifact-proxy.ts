import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Artifact } from "../../artifact/model/artifact.js";
import { artifactResourceName } from "../../cluster/model/cluster-names.js";
import { servicePort } from "../../deployment/adapter/workload-manifests.js";
import { boundAppBody } from "../config/app-forwarding.js";
import { apiKeyHeader } from "../handler/api-key-credentials.js";
import { viewPassBearer } from "../handler/view-pass-credentials.js";
import { hostMessages, hostPage } from "../presenter/host-pages.js";
import type { ArtifactResponseSecrets } from "../interface/artifact-response-secrets.js";
import type { AppResponseGuard } from "../service/app-response-guard.js";

/**
 * Fields that describe one connection rather than the message, which RFC 9110 section 7.6.1 has an
 * intermediary remove before forwarding, and HTTP/2's upgrade settings.
 */
const connectionFields = [
  "connection",
  "proxy-connection",
  "keep-alive",
  "te",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
];

/**
 * Headers without the fields that belong to one connection: the standard connection-specific fields and
 * every field a Connection header names, in any case, whether it arrived once or repeated.
 */
export function withoutConnectionFields(
  headers: IncomingHttpHeaders,
  connection: string | string[] | undefined = headers.connection,
): IncomingHttpHeaders {
  const names = new Set(connectionFields);
  for (const value of [connection ?? []].flat())
    for (const option of value.split(","))
      names.add(option.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !names.has(name.toLowerCase())),
  );
}

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

/**
 * Headers for an artifact's app, without the host's login cookies, a teammate pass in
 * Authorization, or an API key, which the host has already checked and the app already has.
 */
export function withoutHostCredentials(
  headers: IncomingHttpHeaders,
  privateCookies: readonly string[],
): IncomingHttpHeaders {
  const { cookie, authorization, ...rest } = headers;
  delete rest[apiKeyHeader];
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
    /** The app's response body, once its response arrives. */
    let body: Readable | undefined;
    const upstream = `http://${artifactResourceName(artifact.id)}.${this.namespace}.svc.cluster.local:${servicePort}`;
    return reply.from(`${upstream}${pathAndQuery}`, {
      rewriteRequestHeaders: (_request, headers) =>
        this.appRequestHeaders(request, headers, artifact, credentials),
      rewriteHeaders: (headers) => {
        // reply-from normally copies these before onResponse; hold every header until inspected. The
        // app's connection fields, and any it names, end at the host, which frames its own response.
        responseHeaders = withoutConnectionFields(headers);
        return {};
      },
      onResponse: (_request, _response, upstreamResponse) => {
        body = upstreamResponse.stream;
        boundAppBody(body);
        void this.respond(
          request,
          reply,
          body,
          responseHeaders,
          artifact,
          credentials,
        ).catch(() => this.block(reply));
      },
      // reply-from reports failures for the reply that called it.
      onError: (_reply, { error }) => {
        // Reported after the viewer's response finished or the viewer left: nothing is left to answer.
        if (reply.sent || reply.raw.destroyed) return;
        if (body) {
          // The app's response arrived, so respond() or Fastify relays it and answers the viewer. Stop
          // its body, so a cut-off one never ends as if whole, and end a response already under way.
          body.destroy(error);
          if (reply.raw.headersSent) reply.raw.destroy();
          return;
        }
        this.unreachable(reply);
      },
      // reply-from retries a GET its app answers with 503 and leaves that response unread, which would
      // keep its connection until the idle bound and then report a late failure for this reply.
      retryDelay: ({ req, res, err, attempt, getDefaultDelay }) => {
        const delay = getDefaultDelay(req, res, err, attempt);
        // reply-from types the transport's response as a reply.
        const retried = res as unknown as { stream: Readable } | undefined;
        if (delay && !reply.sent) retried?.stream.destroy();
        return delay;
      },
    });
  }

  // ===========================================
  // Request headers
  // ===========================================

  /**
   * The app's request headers: the viewer's end-to-end fields without the host's credentials, the
   * host's forwarding fields, and framing for the body the host forwards. A field the viewer names in
   * Connection never removes one the host sets.
   */
  private appRequestHeaders(
    request: FastifyRequest,
    headers: IncomingHttpHeaders,
    artifact: Artifact,
    credentials: readonly string[],
  ): IncomingHttpHeaders {
    const fields = withoutConnectionFields(headers, request.headers.connection);
    // The host's own server already answered the viewer's Expect.
    delete fields.expect;
    const forwarded: IncomingHttpHeaders = {
      ...withoutHostCredentials(fields, this.privateCookies),
      // reply-from addresses the app.
      host: headers.host,
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
    // The host frames the body it forwards from what its server read: the same length, or chunks when
    // the body came without one. When it forwards no body, it declares none.
    delete forwarded["content-length"];
    if (request.body instanceof Readable) {
      if (request.headers["transfer-encoding"] !== undefined)
        forwarded["transfer-encoding"] = "chunked";
      else if (request.headers["content-length"] !== undefined)
        forwarded["content-length"] = request.headers["content-length"];
    }
    return forwarded;
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
    // Canceling or losing an unread app body emits an error; observe it even before inspection starts.
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
      // The app's connection failed while credentials were read, before anything reached the viewer.
      if (source.destroyed) {
        this.unreachable(reply);
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
      // The viewer left during inspection: release the inspected response unsent.
      if (reply.raw.destroyed) {
        response.stream.destroy();
        return;
      }
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
    // A response that finished or lost its viewer has nothing left to stop or answer.
    if (reply.sent || reply.raw.destroyed) return reply;
    reply.request.log.warn("App response blocked by credential protection");
    if (reply.raw.headersSent) {
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

  /** Tell the viewer the app could not be reached, before any of its response was sent. */
  private unreachable(reply: FastifyReply): FastifyReply {
    return reply
      .code(502)
      .type("text/html; charset=utf-8")
      .send(
        hostPage(
          hostMessages.unreachable.title,
          hostMessages.unreachable.message,
        ),
      );
  }
}
