import { hostname } from "node:os";
import type { FastifyInstance } from "fastify";
import { KubernetesTokenVerifier } from "../../auth/adapter/kubernetes-token-verifier.js";
import { createKubernetesClients } from "../../cluster/factory/kubernetes-client.js";
import { OciChartRegistry } from "../../release/adapter/oci-chart-registry.js";
import { CachedChartVersions } from "../../release/service/cached-chart-versions.js";
import type { ChartVersions } from "../../release/interface/chart-versions.js";
import { FileInstallerSettings } from "../../upgrade/adapter/file-installer-settings.js";
import { KubernetesUpgradeJobs } from "../../upgrade/adapter/kubernetes-upgrade-jobs.js";
import { UpgradeService } from "../../upgrade/service/upgrade-service.js";
import { loadApplicationConfig } from "../config/application-config.js";
import { createHttpApplication } from "../factory/http-application.js";

/** Published versions are listed again after this long. */
const versionCacheMs = 10 * 60 * 1000;

/** Without a chart, upgrades are off and nothing lists its versions. */
const noVersions: ChartVersions = { published: async () => [] };

/** Assemble concrete adapters once at the process boundary and own their lifecycle. */
async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadApplicationConfig(process.env);
  const clients = createKubernetesClients();
  const versions = config.release.chart
    ? new CachedChartVersions(
        new OciChartRegistry(config.release.chart, config.release.plainHttp),
        versionCacheMs,
      )
    : noVersions;
  let app: FastifyInstance | undefined;
  const upgrades = new UpgradeService(
    {
      currentVersion: config.currentVersion,
      chartConfigured: config.release.chart !== "",
    },
    versions,
    new FileInstallerSettings(config.release.settingsFile),
    new KubernetesUpgradeJobs(clients, {
      namespace: config.release.namespace,
      release: config.release.name,
      // A Deployment's pod is named by its hostname.
      podName: hostname(),
    }),
    (error) =>
      app?.log.warn(
        { reason: error instanceof Error ? error.message : "unknown" },
        "The chart registry could not list published versions.",
      ),
  );
  app = await createHttpApplication({
    verifier: new KubernetesTokenVerifier(
      clients.authentication,
      config.caller,
    ),
    upgrades,
  });
  closeOnTermination(app);
  await app.listen({ host: "0.0.0.0", port: config.port });
}

/** Drain requests before Kubernetes terminates the pod. */
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
  console.error("The upgrader could not start", {
    name: failure.name,
    code: failure.code,
    stack: failure.stack?.split("\n").slice(1).join("\n"),
  });
  process.exit(1);
}

main().catch(reportStartupFailure);
