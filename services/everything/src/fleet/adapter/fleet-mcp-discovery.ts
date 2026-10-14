import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { FleetHome } from "../model/fleet-home.js";
import type { FleetMcpEndpoint } from "../model/fleet-mcp-endpoint.js";
import { accepts } from "./listener-probe.js";

/** Time fleetd gets to bind its MCP server once its socket accepts connections. */
const bindTimeoutMs = 30_000;

/** A token Pi sends as written: it neither names a variable (`${…}`) nor runs a command (`!…`). */
const tokenPattern = /^[A-Za-z0-9._~+/=-]+$/;

/**
 * Find fleetd's MCP server through the files fleetd publishes when it binds the server: its
 * loopback port and the bearer token it requires. fleetd binds the server after its socket, so a
 * port is used only once it accepts connections.
 */
export class FleetMcpDiscovery {
  /** Read the discovery files of Fleet's home. */
  constructor(
    private readonly home: Pick<FleetHome, "mcpPort" | "mcpToken">,
    private readonly timeoutMs = bindTimeoutMs,
  ) {}

  /** Wait until fleetd's MCP server accepts connections, then return where it listens. */
  async find(signal?: AbortSignal): Promise<FleetMcpEndpoint> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const published = await this.published();
      if (published && (await accepts(published.port)))
        return {
          url: `http://127.0.0.1:${published.port}/`,
          token: published.token,
        };
      if (Date.now() > deadline)
        throw new Error("fleetd did not start its MCP server.");
      await sleep(250, undefined, { signal });
    }
  }

  /** The port and token fleetd published, or undefined until both are present and well formed. */
  private async published(): Promise<
    { port: number; token: string } | undefined
  > {
    const [port, token] = await Promise.all([
      contentOf(this.home.mcpPort),
      contentOf(this.home.mcpToken),
    ]);
    const number = Number(port);
    if (!/^[0-9]{1,5}$/.test(port) || number < 1 || number > 65_535)
      return undefined;
    if (!tokenPattern.test(token)) return undefined;
    return { port: number, token };
  }
}

/** A file's content without surrounding whitespace, or empty while it does not exist. */
function contentOf(file: string): Promise<string> {
  return readFile(file, "utf8").then(
    (content) => content.trim(),
    () => "",
  );
}
