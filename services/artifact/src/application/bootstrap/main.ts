import type { FastifyInstance } from "fastify";
import { createKeycloakTokenVerifier } from "@everything/security/keycloak";
import { KeycloakClientCredentials } from "@everything/security/client-credentials";
import { KeycloakAppApiClients } from "../../capability/adapter/keycloak-app-api-clients.js";
import { KubernetesCapabilitySecrets } from "../../capability/adapter/kubernetes-capability-secrets.js";
import { PostgresAppApiKeyRepository } from "../../capability/repository/postgres-app-api-key-repository.js";
import { ApiKeyCapability } from "../../capability/service/api-key-capability.js";
import { AppApiKeys } from "../../capability/service/app-api-keys.js";
import { ProvisionedArtifactCapabilities } from "../../capability/service/artifact-capabilities.js";
import { EverythingApiCapability } from "../../capability/service/everything-api-capability.js";
import { HashedAppApiKeyStore } from "../../capability/service/hashed-app-api-key-store.js";
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
import { PostgresReleaseStore } from "../../deployment/repository/postgres-release-store.js";
import { WorkloadReconciler } from "../../deployment/service/workload-reconciler.js";
import { createArtifactDatabase } from "../../persistence/factory/artifact-database.js";
import { PostgresRevisionRepository } from "../../revision/repository/postgres-revision-repository.js";
import { RevisionService } from "../../revision/service/revision-service.js";
import { ArtifactProxy } from "../../viewing/adapter/artifact-proxy.js";
import { ProvisionedClientSecrets } from "../../viewing/adapter/provisioned-client-secrets.js";
import { AppResponseGuard } from "../../viewing/service/app-response-guard.js";
import { ViewCookie } from "../../viewing/handler/view-cookie.js";
import { ViewPassCredentials } from "../../viewing/handler/view-pass-credentials.js";
import {
  PostgresViewGrantRepository,
  PostgresViewPassRepository,
  PostgresViewSessionRepository,
} from "../../viewing/repository/postgres-view-repositories.js";
import { StaticSite } from "../../viewing/service/static-site.js";
import { ViewAccess } from "../../viewing/service/view-access.js";
import { ViewPasses } from "../../viewing/service/view-passes.js";
import { loadApplicationConfig } from "../config/application-config.js";
import { createInternalApplication } from "../factory/internal-application.js";
import {
  createPublicApplication,
  createPublicAppsApplication,
} from "../factory/public-application.js";
import { PeriodicTask } from "../service/periodic-task.js";

import { ArtifactLifecycleService } from "../../artifact/service/artifact-lifecycle-service.js";
import { KubernetesCredentialSecrets } from "../../credential/adapter/kubernetes-credential-secrets.js";
import { PostgresCredentialGrantRepository } from "../../credential/repository/postgres-credential-grant-repository.js";
import { AppCredentials } from "../../credential/service/app-credentials.js";
import { CredentialDistribution } from "../../credential/service/credential-distribution.js";

import { ArtifactVisibilityService } from "../../artifact/service/artifact-visibility-service.js";

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
  const capabilitySecrets = new KubernetesCapabilitySecrets(
    clients,
    config.cluster.artifactNamespace,
  );

  const artifactRepository = new PostgresArtifactRepository(database);
  const revisionRepository = new PostgresRevisionRepository(database);
  const buildRepository = new PostgresBuildRepository(database);
  const deploymentRepository = new PostgresDeploymentRepository(database);
  const lock = new ArtifactLock();
  const lookup = new ArtifactLookup(artifactRepository);
  const credentialGrants = new PostgresCredentialGrantRepository(database);
  const credentialSecrets = new KubernetesCredentialSecrets(
    clients,
    config.cluster.artifactNamespace,
  );
  const apiKeyStore = new HashedAppApiKeyStore(
    new PostgresAppApiKeyRepository(database),
    capabilitySecrets,
  );
  const apiKeys = new AppApiKeys(
    artifactRepository,
    deploymentRepository,
    lookup,
    apiKeyStore,
  );
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
    new ProvisionedArtifactCapabilities(
      [
        new EverythingApiCapability(
          new KeycloakAppApiClients(
            new KeycloakClientCredentials({
              protocolUrl: config.appApi.protocolUrl,
              publicOrigin: config.publicOrigin,
              clientId: config.appApi.clientId,
              clientSecret: config.appApi.clientSecret,
            }),
            {
              adminUrl: config.appApi.adminUrl,
              audience: config.appApi.audience,
            },
          ),
          {
            apiUrl: config.appApi.apiUrl,
            tokenUrl: `${config.appApi.protocolUrl}/token`,
          },
        ),
        new ApiKeyCapability(apiKeyStore),
      ],
      capabilitySecrets,
    ),
    lock,
    credentialGrants,
    credentialSecrets,
  );
  const credentials = new AppCredentials(
    credentialGrants,
    credentialSecrets,
    orchestrator,
    artifactRepository,
    deploymentRepository,
    reconciler,
    lookup,
    lock,
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
  const passes = new ViewPasses(
    lookup,
    new PostgresViewPassRepository(database),
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
    { artifact: config.artifactOrigin, publicApps: config.publicAppsOrigin },
    credentials,
  );

  const internal = await createInternalApplication({
    verifier: createKeycloakTokenVerifier({
      jwksUrl: config.jwksUrl,
      issuer: config.issuer,
      audience: config.audience,
    }),
    artifacts,
    lifecycle: new ArtifactLifecycleService(
      artifactRepository,
      lookup,
      lock,
      reconciler,
    ),
    visibility: new ArtifactVisibilityService(artifactRepository, lookup, lock),
    revisions: new RevisionService(
      artifactRepository,
      revisionRepository,
      content,
      lookup,
      lock,
    ),
    builds,
    deployments: new DeploymentService(
      deploymentRepository,
      buildRepository,
      reconciler,
      orchestrator,
      lookup,
      lock,
      new PostgresReleaseStore(database),
      credentials,
    ),
    credentials,
    distribution: new CredentialDistribution(
      credentialGrants,
      credentialSecrets,
      artifactRepository,
      orchestrator,
      reconciler,
      lock,
    ),
    content,
    access,
    passes,
    apiKeys,
    /** Check the durable backing store before advertising readiness. */
    readiness: async () => {
      await database.getRepository(ArtifactEntity).exists();
    },
  });
  const cookie = new ViewCookie(config.artifactOrigin);
  const passCredentials = new ViewPassCredentials();
  const site = new StaticSite(revisionRepository);
  // One proxy forwards to app pods for both hosts; it withholds the artifact host's cookies and passes.
  const proxy = new ArtifactProxy(
    config.cluster.artifactNamespace,
    [...cookie.privateCookies, passCredentials.cookieName],
    new ProvisionedClientSecrets(deploymentRepository, capabilitySecrets),
    new AppResponseGuard(),
  );
  // Each host serves only its own hostnames, which share no cookie host with the other's.
  const host = await createPublicApplication(
    {
      access,
      cookie,
      passes,
      passCredentials,
      apiKeys,
      artifacts: artifactRepository,
      site,
      content,
      proxy,
      artifactOrigin: config.artifactOrigin,
      publicOrigin: config.publicOrigin,
      publicAppsOrigin: config.publicAppsOrigin,
    },
    config.viewerHostnames.artifact,
  );
  // Public apps are served on their own origin, with no sign-in, pass, or API key, so a public app's
  // pages run under a browser trust boundary separate from the artifact host's private apps.
  const publicApps = await createPublicAppsApplication(
    {
      artifacts: artifactRepository,
      site,
      content,
      proxy,
      publicOrigin: config.publicOrigin,
    },
    config.viewerHostnames.publicApps,
  );

  const tasks = [
    new PeriodicTask("Build monitoring", 3000, () => builds.monitor()),
    new PeriodicTask("Workload reconciliation", 5 * 60 * 1000, () =>
      reconciler.reconcileAll(),
    ),
    new PeriodicTask("View credential cleanup", 60 * 60 * 1000, async () => {
      await access.purge();
      await passes.purge();
    }),
  ];
  internal.addHook("onClose", async () => {
    await Promise.all(tasks.map((task) => task.stop()));
    await publicApps.close();
    await host.close();
    await dataDatabase.destroy();
    await database.destroy();
  });
  closeOnTermination(internal);
  await internal.listen({ host: "0.0.0.0", port: config.internalPort });
  await host.listen({ host: "0.0.0.0", port: config.port });
  await publicApps.listen({ host: "0.0.0.0", port: config.publicAppsPort });
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
