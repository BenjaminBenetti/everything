import Fastify, { type FastifyInstance } from "fastify";
import { errorHandler } from "@everything/errors/fastify";
import { requireAuthentication } from "@everything/security/fastify";
import type { TokenVerifier } from "@everything/security/token-verifier";
import { artifactController } from "../../artifact/controller/artifact-controller.js";
import { appApiKeyController } from "../../capability/controller/app-api-key-controller.js";
import type { AppApiKeys } from "../../capability/service/app-api-keys.js";
import type { ArtifactService } from "../../artifact/service/artifact-service.js";
import { buildController } from "../../image/controller/build-controller.js";
import { buildSourceController } from "../../image/controller/build-source-controller.js";
import type { BuildService } from "../../image/service/build-service.js";
import { contentController } from "../../content/controller/content-controller.js";
import type { ContentStore } from "../../content/interface/content-store.js";
import { deploymentController } from "../../deployment/controller/deployment-controller.js";
import type { DeploymentService } from "../../deployment/service/deployment-service.js";
import {
  healthController,
  type ReadinessCheck,
} from "../../health/controller/health-controller.js";
import { strictRequestValidation } from "../../http/config/request-validation.js";
import { revisionController } from "../../revision/controller/revision-controller.js";
import type { RevisionService } from "../../revision/service/revision-service.js";
import { viewController } from "../../viewing/controller/view-controller.js";
import { viewPassController } from "../../viewing/controller/view-pass-controller.js";
import type { ViewAccess } from "../../viewing/service/view-access.js";
import type { ViewPasses } from "../../viewing/service/view-passes.js";

import { artifactLifecycleController } from "../../artifact/controller/artifact-lifecycle-controller.js";
import type { ArtifactLifecycleService } from "../../artifact/service/artifact-lifecycle-service.js";

/** Use cases served by the internal API. */
export interface InternalDependencies {
  readonly verifier: TokenVerifier;
  readonly artifacts: ArtifactService;
  readonly lifecycle: ArtifactLifecycleService;
  readonly revisions: RevisionService;
  readonly builds: BuildService;
  readonly deployments: DeploymentService;
  readonly content: ContentStore;
  readonly access: ViewAccess;
  readonly passes: ViewPasses;
  readonly apiKeys: Pick<AppApiKeys, "reveal">;
  readonly readiness: ReadinessCheck;
}

/** Largest JSON body: a manifest of the maximum number of files with long paths. */
const bodyLimit = 8 * 1024 * 1024;

/**
 * Compose the internal API, reachable only inside the cluster. Everything calls it with a service
 * token; build jobs download their source with a per-build token.
 */
export async function createInternalApplication(
  dependencies: InternalDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit,
    requestTimeout: 120_000,
    logger: {
      serializers: {
        /** Source tokens travel in query strings and stay out of logs. */
        req(request) {
          return {
            method: request.method,
            url: request.url.split("?")[0] ?? "",
          };
        },
      },
      redact: ["req.headers.authorization"],
    },
    ajv: strictRequestValidation,
  });
  app.setErrorHandler(errorHandler);
  await healthController(app, dependencies.readiness);
  await app.register(
    async (scope) =>
      buildSourceController(scope, dependencies.builds, dependencies.content),
    { prefix: "/internal/v1" },
  );
  await app.register(
    async (scope) => {
      requireAuthentication(scope, dependencies.verifier);
      await artifactController(scope, dependencies.artifacts);
      await artifactLifecycleController(
        scope,
        dependencies.lifecycle,
        dependencies.artifacts,
      );
      await revisionController(
        scope,
        dependencies.revisions,
        dependencies.artifacts,
      );
      await buildController(scope, dependencies.builds);
      await deploymentController(
        scope,
        dependencies.deployments,
        dependencies.artifacts,
      );
      await contentController(scope, dependencies.content);
      await viewController(scope, dependencies.access);
      await viewPassController(scope, dependencies.passes);
      await appApiKeyController(scope, dependencies.apiKeys);
    },
    { prefix: "/internal/v1" },
  );
  return app;
}
