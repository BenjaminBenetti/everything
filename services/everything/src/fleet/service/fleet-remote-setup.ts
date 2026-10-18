import { randomUUID } from "node:crypto";
import { constants, copyFile } from "node:fs/promises";
import { readJsonObject, writePrivateJson } from "../adapter/private-files.js";
import type { FleetHome } from "../model/fleet-home.js";
import { withGatewayRemote } from "../model/fleet-remote.js";
import type { FleetRemote } from "../model/fleet-settings.js";

/**
 * Register fleetd with Everything's internal gateway before it starts. fleetd reads its settings
 * when it starts and owns them while it runs, so settings that already match are left untouched.
 * Its token is never written here: fleetd keeps the one it already has, which its existing MCP and
 * remote clients hold, or mints one in a fresh home, and the client publisher passes that same token
 * to teammates. Settings fleetd could not read either, which it would start without, are first
 * copied to a new recovery file beside them, so no earlier recovery copy is ever overwritten.
 */
export class FleetRemoteSetup {
  /** Configure the settings in `home` for `remote`; without it, fleetd's remote settings stay as they are. */
  constructor(
    private readonly home: Pick<FleetHome, "config">,
    private readonly remote: FleetRemote | undefined,
  ) {}

  /** Write the gateway registration where it differs from what fleetd has. */
  async apply(): Promise<void> {
    if (!this.remote) return;
    const config = await readJsonObject(this.home.config).catch(
      async (error: unknown) => {
        if (!(error instanceof SyntaxError)) throw error;
        await this.keepUnreadable();
        return {};
      },
    );
    const configured = withGatewayRemote(config, this.remote.gatewayUrl);
    if (JSON.stringify(configured) !== JSON.stringify(config))
      await writePrivateJson(this.home.config, configured);
  }

  /** Copy the unreadable settings to a recovery file of their own, failing rather than replacing one. */
  private async keepUnreadable(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(
      this.home.config,
      `${this.home.config}.unreadable-${stamp}-${randomUUID().slice(0, 8)}`,
      constants.COPYFILE_EXCL,
    );
  }
}
