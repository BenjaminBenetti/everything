import { rename } from "node:fs/promises";
import {
  readJsonObject,
  readOptional,
  replaceFile,
  writePrivateJson,
} from "../adapter/private-files.js";
import type { FleetHome } from "../model/fleet-home.js";
import { withGatewayRemote } from "../model/fleet-remote.js";
import type { FleetRemote } from "../model/fleet-settings.js";

/**
 * Prepare fleetd for remote control through Everything's internal gateway before it starts: give it
 * the chart's client token, which it then requires of remote clients and MCP alike, and register it
 * with the gateway. fleetd reads both when it starts and owns its settings while it runs, so files
 * that already match are left untouched. Settings fleetd could not read either, which it would start
 * without, are kept beside the new file rather than overwritten.
 */
export class FleetRemoteSetup {
  /** Configure the files of `home` for `remote`; without it, fleetd's remote settings stay as they are. */
  constructor(
    private readonly home: Pick<FleetHome, "mcpToken" | "config">,
    private readonly remote: FleetRemote | undefined,
  ) {}

  /** Write the token and the gateway registration where they differ from what fleetd has. */
  async apply(): Promise<void> {
    if (!this.remote) return;
    if ((await readOptional(this.home.mcpToken))?.trim() !== this.remote.token)
      await replaceFile(this.home.mcpToken, this.remote.token);
    const config = await readJsonObject(this.home.config).catch(
      async (error: unknown) => {
        if (!(error instanceof SyntaxError)) throw error;
        await rename(this.home.config, `${this.home.config}.unreadable`);
        return {};
      },
    );
    const configured = withGatewayRemote(config, this.remote.gatewayUrl);
    if (JSON.stringify(configured) !== JSON.stringify(config))
      await writePrivateJson(this.home.config, configured);
  }
}
