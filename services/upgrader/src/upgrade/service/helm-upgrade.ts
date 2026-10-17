import { access, mkdtemp, readdir } from "node:fs/promises";
import path from "node:path";
import type { ReleaseConfig } from "../../application/config/application-config.js";
import {
  CommandFailure,
  type CommandRunner,
} from "../interface/command-runner.js";
import { helmTimeout } from "../model/upgrade-job-manifest.js";

/** Explanations are cut to this many of Helm's last lines when it printed no error line. */
const keptLines = 15;

/** Why an upgrade stopped, in words safe to show the person who started it. */
export class UpgradeFailure extends Error {
  /** Keep the explanation as the message. */
  constructor(message: string) {
    super(message);
    this.name = "UpgradeFailure";
  }
}

/**
 * Installs a released version the way the installer does: the new chart with its own production
 * values and the installer's settings over them. Helm waits for the new version to become ready and
 * rolls back to the previous one when it does not.
 */
export class HelmUpgrade {
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the release, the command runner, and a directory for the downloaded chart. */
  constructor(
    private readonly release: ReleaseConfig,
    private readonly commands: CommandRunner,
    private readonly workDirectory: string,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Download the version's chart and upgrade the release to it. */
  async install(version: string): Promise<void> {
    const { chart, name, namespace, settingsFile } = this.release;
    const directory = await mkdtemp(path.join(this.workDirectory, "chart-"));
    await this.helm([
      "pull",
      chart,
      "--version",
      version,
      "--untar",
      "--untardir",
      directory,
      ...(this.release.plainHttp ? ["--plain-http"] : []),
    ]);
    const [chartName] = await readdir(directory);
    const chartDirectory = path.join(directory, chartName ?? "");
    const productionValues = path.join(chartDirectory, "values.prod.yaml");
    try {
      await access(productionValues);
    } catch {
      throw new UpgradeFailure(
        `Version ${version} of the chart has no values.prod.yaml. Use the installer to upgrade.`,
      );
    }
    await this.helm([
      "upgrade",
      name,
      chartDirectory,
      "--namespace",
      namespace,
      "--reset-values",
      "--values",
      productionValues,
      "--values",
      settingsFile,
      // Keep the settings in the cluster for the next upgrade, as the installer does.
      "--set-file",
      `upgrades.settings=${settingsFile}`,
      "--rollback-on-failure",
      "--wait",
      "--timeout",
      helmTimeout,
    ]);
  }

  // ===========================================
  // Helm boundary
  // ===========================================

  /** Run Helm, turning a failure into Helm's own explanation. */
  private async helm(args: readonly string[]): Promise<void> {
    try {
      await this.commands.run("helm", args);
    } catch (error) {
      if (error instanceof CommandFailure)
        throw new UpgradeFailure(helmError(error.output));
      throw error;
    }
  }
}

/** Helm's `Error:` lines, or the end of its output when it printed none. */
export function helmError(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const errors = lines.filter((line) => line.startsWith("Error:"));
  const explanation = (
    errors.length > 0 ? errors : lines.slice(-keptLines)
  ).join("\n");
  return explanation || "Helm stopped without explaining why.";
}
