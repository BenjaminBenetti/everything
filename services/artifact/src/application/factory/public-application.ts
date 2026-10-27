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
import { hostMessages, hostPage } from "../../viewing/presenter/host-pages.js";

/** Build a host app with the shared transport setup, then register its routes. */
async function hostApplication(
  register: (app: FastifyInstance) => Promise<void>,
): Promise<FastifyInstance> {
  const app = Fastify({
    // The scheme and client address come from the ingress's forwarded headers.
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

/** Compose the artifact host, served through the Ingress on the artifact origin. */
export function createPublicApplication(
  dependencies: ArtifactHostDependencies,
): Promise<FastifyInstance> {
  return hostApplication((app) => artifactHostController(app, dependencies));
}

/** Compose the public apps host, served through its own Ingress on the public apps origin. */
export function createPublicAppsApplication(
  dependencies: PublicAppsHostDependencies,
): Promise<FastifyInstance> {
  return hostApplication((app) => publicAppsHostController(app, dependencies));
}
