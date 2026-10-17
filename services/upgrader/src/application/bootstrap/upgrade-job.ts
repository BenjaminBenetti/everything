import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ProcessCommandRunner } from "../../upgrade/adapter/process-command-runner.js";
import {
  HelmUpgrade,
  UpgradeFailure,
} from "../../upgrade/service/helm-upgrade.js";
import { loadUpgradeJobConfig } from "../config/application-config.js";

/** Kubernetes reports this file's contents as the reason the container stopped. */
const terminationLog = "/dev/termination-log";

/** Install the version the upgrader chose; an upgrade Job runs this once. */
async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadUpgradeJobConfig(process.env);
  console.log(`Upgrading ${config.release.name} to ${config.version}.`);
  await new HelmUpgrade(
    config.release,
    new ProcessCommandRunner(),
    tmpdir(),
  ).install(config.version);
  console.log(`Upgraded ${config.release.name} to ${config.version}.`);
}

/** Record why the upgrade stopped, which the upgrader shows; other messages may hold configuration. */
async function reportFailure(error: unknown): Promise<never> {
  const message =
    error instanceof UpgradeFailure
      ? error.message
      : `The upgrade could not start (${(error as { name?: string }).name ?? "unknown error"}).`;
  console.error(message);
  await writeFile(terminationLog, message).catch(() => undefined);
  process.exit(1);
}

main().catch(reportFailure);
