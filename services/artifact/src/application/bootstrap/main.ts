import type { FastifyInstance } from "fastify";
import { createKeycloakTokenVerifier } from "@everything/security/keycloak";
import { ArtifactEntity } from "../../artifact/schema/artifact-entity.js";
import { PostgresArtifactRepository } from "../../artifact/repository/postgres-artifact-repository.js";
import { ArtifactLock } from "../../artifact/service/artifact-lock.js";
import { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import { ArtifactService } from "../../artifact/service/artifact-service.js";
import { BuildkitJobRunner } from "../../image/adapter/buildkit-job-runner.js";
import { DistributionRegistry } from "../../image/adapter/distribution-registry.js";
import { PostgresBuildRepository } from "../../image/repository/postgres-build-repository.js";
import { BuildService } from "../../image/service/build-service.js";
import { createKubernetesClients } from "../../cluster/factory/kubernetes-client.js";
import { FileContentStore } from "../../content/service/file-content-store.js";
import { PostgresArtifactDatabases } from "../../database/adapter/postgres-artifact-databases.js";
import { createArtifactDataDatabase } from "../../database/factory/artifact-data-database.js";
import { KubernetesWorkloads } from "../../deployment/adapter/kubernetes-workloads.js";
import { PostgresDeploymentRepository } from "../../deployment/repository/postgres-deployment-repository.js";
import { DeploymentService } from "../../deployment/service/deployment-service.js";
import { WorkloadReconciler } from "../../deployment/service/workload-reconciler.js";
import { createArtifactDatabase } from "../../persistence/factory/artifact-database.js";
import { PostgresRevisionRepository } from "../../revision/repository/postgres-revision-repository.js";
import { RevisionService } from "../../revision/service/revision-service.js";
import { ArtifactProxy } from "../../viewing/adapter/artifact-proxy.js";
import { ViewCookie } from "../../viewing/handler/view-cookie.js";
import {
  PostgresViewGrantRepository,
  PostgresViewSessionRepository,
} from "../../viewing/repository/postgres-view-repositories.js";
import { StaticSite } from "../../viewing/service/static-site.js";
import { ViewAccess } from "../../viewing/service/view-access.js";
import { loadApplicationConfig } from "../config/application-config.js";
import { createInternalApplication } from "../factory/internal-application.js";
import { createPublicApplication } from "../factory/public-application.js";
import { PeriodicTask } from "../service/periodic-task.js";

/** Assemble concrete adapters once at the process boundary and own their lifecycle. */
async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadApplicationConfig(process.env);
  const database = createArtifactDatabase(config);
  await database.initialize();
  await database.runMigrations();
  const dataDatabase = createArtifactDataDatabase(
    config,
    config.artifactData.database,
  );
  await dataDatabase.initialize();
  const clients = createKubernetesClients();

  const artifactRepository = new PostgresArtifactRepository(database);
  const revisionRepository = new PostgresRevisionRepository(database);
  const buildRepository = new PostgresBuildRepository(database);
  const deploymentRepository = new PostgresDeploymentRepository(database);
  const lock = new ArtifactLock();
  const lookup = new ArtifactLookup(artifactRepository);
  const content = new FileContentStore(config.contentDirectory);
  const orchestrator = new KubernetesWorkloads(clients, {
    namespace: config.cluster.artifactNamespace,
    pullSecret: config.registry.pullSecret,
    storageClassName: config.cluster.storageClassName,
  });
  const reconciler = new WorkloadReconciler(
    artifactRepository,
    deploymentRepository,
    orchestrator,
    new PostgresArtifactDatabases(dataDatabase, config.artifactData),
    config.registry.pullHost,
  );
  const builds = new BuildService(
    buildRepository,
    deploymentRepository,
    content,
    new BuildkitJobRunner(clients, {
      namespace: config.cluster.buildNamespace,
      image: config.buildkitImage,
      pushSecret: config.registry.pushSecret,
    }),
    new DistributionRegistry(config.registry),
    lookup,
    lock,
    { sourceUrl: config.buildSourceUrl, pushHost: config.registry.pushHost },
  );
  const access = new ViewAccess(
    artifactRepository,
    new PostgresViewGrantRepository(database),
    new PostgresViewSessionRepository(database),
    config.artifactOrigin,
  );
  const artifacts = new ArtifactService(
    artifactRepository,
    revisionRepository,
    buildRepository,
    deploymentRepository,
    orchestrator,
    { builds, workloads: reconciler },
    lookup,
    lock,
    config.artifactOrigin,
  );

  const internal = await createInternalApplication({
    verifier: createKeycloakTokenVerifier({
      jwksUrl: config.jwksUrl,
      issuer: config.issuer,
      audience: config.audience,
    }),
    artifacts,
    revisions: new RevisionService(
      artifactRepository,
      revisionRepository,
      content,
      lookup,
      lock,
    ),
    builds,
    deployments: new DeploymentService(
      artifactRepository,
      deploymentRepository,
      buildRepository,
      reconciler,
      orchestrator,
      lookup,
      lock,
    ),
    content,
    access,
    /** Check the durable backing store before advertising readiness. */
    readiness: async () => {
      await database.getRepository(ArtifactEntity).exists();
    },
  });
  const cookie = new ViewCookie(config.artifactOrigin);
  const host = await createPublicApplication({
    access,
    cookie,
    artifacts: artifactRepository,
    site: new StaticSite(revisionRepository),
    content,
    proxy: new ArtifactProxy(
      config.cluster.artifactNamespace,
      cookie.privateCookies,
    ),
    publicOrigin: config.publicOrigin,
  });

  const tasks = [
    new PeriodicTask("Build monitoring", 3000, () => builds.monitor()),
    new PeriodicTask("Workload reconciliation", 5 * 60 * 1000, () =>
      reconciler.reconcileAll(),
    ),
    new PeriodicTask("View credential cleanup", 60 * 60 * 1000, () =>
      access.purge(),
    ),
  ];
  internal.addHook("onClose", async () => {
    await Promise.all(tasks.map((task) => task.stop()));
    await host.close();
    await dataDatabase.destroy();
    await database.destroy();
  });
  closeOnTermination(internal);
  await internal.listen({ host: "0.0.0.0", port: config.internalPort });
  await host.listen({ host: "0.0.0.0", port: config.port });
  for (const task of tasks) task.start();
}

/** Drain requests and background work before Kubernetes terminates the pod. */
function closeOnTermination(app: FastifyInstance): void {
  /** Close the application, then exit with an outcome Kubernetes can report. */
  async function shutdown(): Promise<void> {
    try {
      await app.close();
      process.exit(0);
    } catch {
      console.error("Graceful shutdown failed.");
      process.exit(1);
    }
  }
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

/** Log the failure's type and location only; messages may contain configuration values. */
function reportStartupFailure(error: unknown): never {
  const failure = error as { name?: string; code?: string; stack?: string };
  console.error("The artifact service could not start", {
    name: failure.name,
    code: failure.code,
    stack: failure.stack?.split("\n").slice(1).join("\n"),
  });
  process.exit(1);
}

main().catch(reportStartupFailure);
