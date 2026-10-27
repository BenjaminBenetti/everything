import fastifyCookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import replyFrom from "@fastify/reply-from";
import Fastify, { type FastifyInstance } from "fastify";
import {
  artifactHostController,
  type ArtifactHostDependencies,
} from "../../viewing/controller/artifact-host-controller.js";
import {
  publicAppsHostController,
  type PublicAppsHostDependencies,
} from "../../viewing/controller/public-apps-host-controller.js";
import { HostAdmission } from "../../viewing/handler/host-admission.js";
import { hostMessages, hostPage } from "../../viewing/presenter/host-pages.js";

/**
 * Build a host app that serves only requests for its own hostnames, with the shared transport setup,
 * then register its routes.
 */
async function hostApplication(
  hostnames: readonly string[],
  register: (app: FastifyInstance) => Promise<void>,
): Promise<FastifyInstance> {
  const app = Fastify({
    // The scheme and client address come from the ingress's forwarded headers. The hostname does not:
    // HostAdmission reads the Host header itself, never the X-Forwarded-Host a caller can send.
    trustProxy: true,
    logger: {
      serializers: {
        /** View codes travel in query strings and stay out of logs. */
        req(request) {
          return {
            method: request.method,
            url: request.url.split("?")[0] ?? "",
          };
        },
      },
      redact: [
        "req.headers.cookie",
        "req.headers.authorization",
        'req.headers["x-api-key"]',
        "res.headers.set-cookie",
      ],
    },
  });
  // First of all: a request for another hostname is refused before cookies are even parsed.
  new HostAdmission(hostnames).register(app);
  await app.register(fastifyCookie);
  // Only routes that opt in are limited: signed-in viewers browse artifacts without limits.
  await app.register(rateLimit, { global: false });
  await app.register(replyFrom, { disableRequestLogging: true });
  // Request bodies pass through unparsed to dynamic artifacts.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, payload, done) =>
    done(null, payload),
  );
  app.setErrorHandler(async (error, request, reply) => {
    request.log.error(
      { name: (error as Error).name },
      "Artifact request failed",
    );
    return reply
      .code(500)
      .type("text/html; charset=utf-8")
      .send(
        hostPage(
          hostMessages.unreachable.title,
          hostMessages.unreachable.message,
        ),
      );
  });
  app.setNotFoundHandler(async (_request, reply) =>
    reply
      .code(404)
      .type("text/html; charset=utf-8")
      .send(
        hostPage(hostMessages.notFound.title, hostMessages.notFound.message),
      ),
  );
  await register(app);
  return app;
}

/**
 * Compose the artifact host, served through the Ingress on the artifact origin and inside the cluster
 * on `hostnames`, the artifact host's cookie hosts, which share none with the public apps host's.
 */
export function createPublicApplication(
  dependencies: ArtifactHostDependencies,
  hostnames: readonly string[],
): Promise<FastifyInstance> {
  return hostApplication(hostnames, (app) =>
    artifactHostController(app, dependencies),
  );
}

/**
 * Compose the public apps host, served through its own Ingress on the public apps origin and inside
 * the cluster on `hostnames`, its cookie hosts, which share none with the artifact host's or the
 * application's.
 */
export function createPublicAppsApplication(
  dependencies: PublicAppsHostDependencies,
  hostnames: readonly string[],
): Promise<FastifyInstance> {
  return hostApplication(hostnames, (app) =>
    publicAppsHostController(app, dependencies),
  );
}
