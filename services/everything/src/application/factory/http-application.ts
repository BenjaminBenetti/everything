import fastifyCookie from "@fastify/cookie";
import type { SessionOperations } from "../../session/interface/session-operations.js";
import { SessionCookie } from "../../session/handler/session-cookie.js";
import { sessionController } from "../../session/controller/session-controller.js";
import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
} from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { requireAuthentication } from "@everything/security/fastify";
import type { TokenVerifier } from "@everything/security/token-verifier";
import { agentController } from "../../agent/controller/agent-controller.js";
import { agentEditingController } from "../../agent/controller/agent-editing-controller.js";
import type { AgentEditing } from "../../agent/interface/agent-editing.js";
import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import type { AgentRemoval } from "../../agent/interface/agent-removal.js";
import { conversationController } from "../../conversation/controller/conversation-controller.js";
import type { ConversationOperations } from "../../conversation/interface/conversation-operations.js";
import {
  healthController,
  type ReadinessCheck,
} from "../../health/controller/health-controller.js";
import { strictRequestValidation } from "../../http/config/request-validation.js";
import { errorHandler } from "../../http/handler/error-handler.js";
import { identityController } from "../../identity/controller/identity-controller.js";

/** Use cases and transport settings supplied by the composition root. */
export interface HttpDependencies {
  readonly verifier: TokenVerifier;
  readonly sessions: SessionOperations;
  readonly publicOrigin: string;
  readonly agents: Omit<AgentCatalog, "delete">;
  readonly profiles: AgentEditing;
  readonly removal: AgentRemoval;
  readonly conversations: ConversationOperations;
  readonly readiness: ReadinessCheck;
}

/** Compose transport protections and routes; TLS terminates at the cluster's ingress. */
export async function createHttpApplication(
  dependencies: HttpDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    // Client addresses for rate limiting and logs come from the ingress's forwarded headers.
    trustProxy: true,
    bodyLimit: 64 * 1024,
    requestTimeout: 15_000,
    logger: {
      redact: [
        "req.body.password",
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
      ],
    },
    ajv: strictRequestValidation,
  });
  await app.register(helmet);
  await app.register(fastifyCookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.setErrorHandler(errorHandler);
  await healthController(app, dependencies.readiness);
  const cookie = new SessionCookie(dependencies.publicOrigin);
  await app.register(
    async (scope) => sessionController(scope, dependencies.sessions, cookie),
    { prefix: "/v1" },
  );
  await app.register(protectedApi(dependencies, cookie), { prefix: "/v1" });
  return app;
}

/** Routes accept verified bearer tokens or browser sessions and must never be cached. */
function protectedApi(
  dependencies: HttpDependencies,
  cookie: SessionCookie,
): FastifyPluginAsync {
  return async (scope) => {
    scope.addHook("onRequest", async (request) => {
      cookie.protectMutation(request);
    });
    requireAuthentication(
      scope,
      dependencies.verifier,
      async (request) =>
        (await dependencies.sessions.resolve(cookie.read(request)))
          ?.accessToken,
    );
    scope.addHook("onSend", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
    });
    await identityController(scope);
    await conversationController(scope, dependencies.conversations);
    await agentController(scope, dependencies.agents, dependencies.removal);
    await agentEditingController(scope, dependencies.profiles);
  };
}
