import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FleetCommands } from "../interface/fleet-commands.js";
import {
  connectionFields,
  connectionName,
  dockerConfigWithLogin,
  findConnection,
  inClusterKubeconfig,
  privilegedField,
} from "../model/fleet-connection.js";
import type { FleetHome } from "../model/fleet-home.js";
import type { FleetSettings } from "../model/fleet-settings.js";

/**
 * Connect fleetd to the cluster Everything runs in: write the kubeconfig and registry login it
 * reads, then add the `everything` connection, or bring the settings Everything manages up to date
 * on one added before.
 */
export class FleetConnectionSetup {
  /** Configure the daemon reached by `commands`, whose files are in `home`. */
  constructor(
    private readonly commands: FleetCommands,
    private readonly home: FleetHome,
    private readonly settings: FleetSettings,
  ) {}

  /** Write Fleet's configuration files and make the connection match the chart's settings. */
  async apply(): Promise<void> {
    await writePrivateJson(
      this.home.kubeconfig,
      inClusterKubeconfig(this.settings.namespace),
    );
    await writePrivateJson(
      this.home.dockerConfig,
      dockerConfigWithLogin(
        await readJsonObject(this.home.dockerConfig),
        this.settings.registry,
      ),
    );
    const connection = findConnection(
      await this.commands.run(["cluster", "ls", "--json"]),
    );
    // Workers run unprivileged until the user allows it in Everything's settings, on every kind of
    // cluster: left unset, Fleet would allow privileged pods on local clusters only.
    const fields = [
      ...connectionFields(this.settings),
      ...(connection?.allow_privileged === undefined
        ? [privilegedField(false)]
        : []),
    ];
    if (connection) {
      await this.commands.run(["cluster", "set", connectionName, ...fields]);
      return;
    }
    await this.commands.run([
      "cluster",
      "add",
      connectionName,
      `--name=${connectionName}`,
      `--namespace=${this.settings.namespace}`,
      `--kubeconfig=${this.home.kubeconfig}`,
      ...fields,
    ]);
  }
}

/** A JSON file's object, or an empty one when the file does not exist. */
async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** Replace a file readable only by Everything's user with JSON, all at once. */
async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const partial = `${file}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(partial, file);
  } finally {
    await rm(partial, { force: true });
  }
}
