import type { WorkerSettings } from "@everything/settings-contracts";
import type { WorkerSettingsOperations } from "../../settings/interface/worker-settings.js";
import { WorkersUnavailableError } from "../error/fleet-errors.js";
import type { FleetAvailability } from "../interface/fleet-availability.js";
import type { FleetCommands } from "../interface/fleet-commands.js";
import {
  connectionName,
  findConnection,
  privilegedField,
} from "../model/fleet-connection.js";

/**
 * Keep the worker settings on Everything's Fleet connection, so Fleet's own client shows the same
 * values. Workers are privileged only where the connection explicitly allows it.
 */
export class FleetWorkerSettings implements WorkerSettingsOperations {
  /** Reach the daemon Everything supervises once it runs. */
  constructor(
    private readonly fleet: FleetAvailability,
    private readonly commands: FleetCommands,
  ) {}

  /** Read the connection's settings from fleetd. */
  async read(): Promise<WorkerSettings> {
    const connection = findConnection(
      await this.run(["cluster", "ls", "--json"]),
    );
    if (!connection) throw new WorkersUnavailableError();
    return { privileged: connection.allow_privileged === true };
  }

  /** Change the connection's settings; workers created afterwards follow them. */
  async update(settings: WorkerSettings): Promise<WorkerSettings> {
    await this.run([
      "cluster",
      "set",
      connectionName,
      privilegedField(settings.privileged),
    ]);
    return this.read();
  }

  /** Run a Fleet command once Fleet runs; before then, a command would start a daemon of its own. */
  private async run(args: readonly string[]): Promise<string> {
    if (!this.fleet.running) throw new WorkersUnavailableError();
    try {
      return await this.commands.run(args);
    } catch {
      throw new WorkersUnavailableError();
    }
  }
}
