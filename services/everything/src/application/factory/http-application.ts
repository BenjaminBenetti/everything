import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
} from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { requireAuthentication } from "@everything/security/fastify";
import type { TokenVerifier } from "@everything/security/token-verifier";
import { agentController } from "../../agent/controller/agent-controller.js";
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
  readonly agents: Omit<AgentCatalog, "delete">;
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
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
      ],
    },
    ajv: strictRequestValidation,
  });
  await app.register(helmet);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.setErrorHandler(errorHandler);
  await healthController(app, dependencies.readiness);
  await app.register(protectedApi(dependencies), { prefix: "/v1" });
  return app;
}

/** Routes that require a verified bearer token and must never be cached. */
function protectedApi(dependencies: HttpDependencies): FastifyPluginAsync {
  return async (scope) => {
    requireAuthentication(scope, dependencies.verifier);
    scope.addHook("onSend", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
    });
    await identityController(scope);
    await conversationController(scope, dependencies.conversations);
    await agentController(scope, dependencies.agents, dependencies.removal);
  };
}
