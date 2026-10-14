import { FleetCli } from "../adapter/fleet-cli.js";
import { FleetMcpDiscovery } from "../adapter/fleet-mcp-discovery.js";
import { fleetEnvironment, fleetHome } from "../model/fleet-home.js";
import { fleetArchitecture } from "../model/fleet-release-files.js";
import type { FleetSettings } from "../model/fleet-settings.js";
import { FleetConnectionSetup } from "../service/fleet-connection-setup.js";
import { FleetDaemon } from "../service/fleet-daemon.js";
import { FleetHost } from "../service/fleet-host.js";
import { FleetInstaller } from "../service/fleet-installer.js";
import { FleetWorkerSettings } from "../service/fleet-worker-settings.js";

/** Fleet inside this container, and the worker settings it keeps on its cluster connection. */
export interface FleetRuntime {
  readonly host: FleetHost;
  readonly workers: FleetWorkerSettings;
}

/** Assemble Fleet's runtime for this container from the chart's settings. */
export function createFleetRuntime(
  settings: FleetSettings,
  reportFailure: (error: unknown) => void,
): FleetRuntime {
  const home = fleetHome(settings.home);
  const environment = fleetEnvironment(home, process.env);
  const commands = new FleetCli(home.executable, environment);
  const host = new FleetHost(
    new FleetInstaller(
      settings.release,
      home.binaries,
      fleetArchitecture(process.arch),
    ),
    new FleetDaemon(home.executable, environment, home.socket, reportFailure),
    new FleetConnectionSetup(commands, home, settings),
    new FleetMcpDiscovery(home),
    reportFailure,
  );
  return { host, workers: new FleetWorkerSettings(host, commands) };
}
