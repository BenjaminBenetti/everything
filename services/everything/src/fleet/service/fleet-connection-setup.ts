import { readJsonObject, writePrivateJson } from "../adapter/private-files.js";
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
