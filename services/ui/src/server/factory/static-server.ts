import { access } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import staticFiles from "@fastify/static";

/** Serve the stateless SPA; authentication belongs to the API. */
export async function createStaticServer(root: string) {
  const app = Fastify({
    logger: {
      level: "warn",
      redact: ["req.headers.cookie", "req.headers.authorization"],
    },
  });
  await access(join(root, "index.html"));
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        frameSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
  });
  app.addHook("onSend", async (request, reply) => {
    // Voice input records only on the application's own pages, never inside an embedded frame.
    reply.header("Permissions-Policy", "microphone=(self)");
    const pathname = request.url.split("?")[0] ?? "";
    reply.header(
      "Cache-Control",
      pathname.startsWith("/assets/") && reply.statusCode === 200
        ? "public, max-age=31536000, immutable"
        : "no-store",
    );
  });
  app.get("/ui-health", async () => ({ status: "ok" }));
  // An allowlist prevents missing assets and misrouted API requests receiving HTML.
  const pages = new Set([
    "/",
    "/login",
    "/team",
    "/team/:agentId",
    "/workspaces",
    "/keys",
    "/updates",
    "/apps",
    "/apps/open",
  ]);
  for (const path of pages)
    app.get(path, async (_request, reply) =>
      reply.type("text/html").sendFile("index.html"),
    );
  // Keep saved links working, including the requested app and page in the query string.
  for (const path of ["/artifacts", "/artifacts/open"])
    app.get(path, async (request, reply) =>
      reply.redirect(`/apps${request.url.slice("/artifacts".length)}`, 308),
    );
  await app.register(staticFiles, { root, index: false, cacheControl: false });
  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ message: "Not found" }),
  );
  return app;
}
