import Fastify, { type FastifyInstance } from "fastify";
import { errorHandler } from "@everything/errors/fastify";
import { requireAuthentication } from "@everything/security/fastify";
import type { TokenVerifier } from "@everything/security/token-verifier";
import { healthController } from "../../health/controller/health-controller.js";
import { strictRequestValidation } from "../../http/config/request-validation.js";
import { upgradeController } from "../../upgrade/controller/upgrade-controller.js";
import type { UpgradeOperations } from "../../upgrade/interface/upgrade-operations.js";

/** Use cases and the caller check supplied by the composition root. */
export interface HttpDependencies {
  readonly verifier: TokenVerifier;
  readonly upgrades: UpgradeOperations;
}

/** Compose the API, reachable only inside the cluster and only by Everything's service account. */
export async function createHttpApplication(
  dependencies: HttpDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 4 * 1024,
    requestTimeout: 60_000,
    logger: { redact: ["req.headers.authorization"] },
    ajv: strictRequestValidation,
  });
  app.setErrorHandler(errorHandler);
  // The process serves nothing it must wait on, so it is ready once it listens.
  await healthController(app, async () => {});
  await app.register(
    async (scope) => {
      requireAuthentication(scope, dependencies.verifier);
      await upgradeController(scope, dependencies.upgrades);
    },
    { prefix: "/v1" },
  );
  return app;
}
