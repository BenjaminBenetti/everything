import pRetry from "p-retry";
import type { FleetMcpDiscovery } from "../adapter/fleet-mcp-discovery.js";
import type { FleetAvailability } from "../interface/fleet-availability.js";
import type { FleetMcpServer } from "../interface/fleet-mcp-server.js";
import type { FleetMcpEndpoint } from "../model/fleet-mcp-endpoint.js";
import type { FleetConnectionSetup } from "./fleet-connection-setup.js";
import type { FleetDaemon } from "./fleet-daemon.js";
import type { FleetInstaller } from "./fleet-installer.js";

/**
 * Run Fleet inside Everything: install the pinned release, start fleetd, connect it to the cluster,
 * and find its MCP server for teammates. Everything serves without Fleet, so startup retries in the
 * background until it succeeds or Everything stops.
 */
export class FleetHost implements FleetMcpServer, FleetAvailability {
  // ===========================================
  // Construction and state
  // ===========================================

  private readonly stopping = new AbortController();
  private starting: Promise<void> | undefined;
  private mcpEndpoint: FleetMcpEndpoint | undefined;
  private announceRunning!: (endpoint: FleetMcpEndpoint) => void;
  private readonly runningAnnounced = new Promise<FleetMcpEndpoint>(
    (resolve) => (this.announceRunning = resolve),
  );

  /** Receive the parts of Fleet's runtime. */
  constructor(
    private readonly installer: FleetInstaller,
    private readonly daemon: FleetDaemon,
    private readonly connection: FleetConnectionSetup,
    private readonly mcp: FleetMcpDiscovery,
    private readonly reportFailure: (error: unknown) => void,
  ) {}

  // ===========================================
  // MCP server
  // ===========================================

  /** fleetd's MCP server once Fleet is running. */
  get endpoint(): FleetMcpEndpoint | undefined {
    return this.mcpEndpoint;
  }

  /** True once Fleet has started: installed, supervised, connected, and serving MCP. */
  get running(): boolean {
    return this.mcpEndpoint !== undefined;
  }

  /** Resolve once Fleet is running; while it never starts, this never settles. */
  whenRunning(): Promise<FleetMcpEndpoint> {
    return this.runningAnnounced;
  }

  // ===========================================
  // Lifecycle
  // ===========================================

  /** Bring Fleet up in the background, retrying with backoff after each failure. */
  start(): void {
    this.starting ??= pRetry(() => this.bringUp(), {
      retries: Infinity,
      minTimeout: 5_000,
      maxTimeout: 300_000,
      signal: this.stopping.signal,
      // After close, the abort itself arrives as a failed attempt.
      onFailedAttempt: ({ error }) => {
        if (!this.stopping.signal.aborted) this.reportFailure(error);
      },
    }).catch(() => undefined);
  }

  /** Stop retrying and stop fleetd, which ends a startup waiting on it. */
  async close(): Promise<void> {
    this.stopping.abort();
    await this.daemon.close();
    await this.starting;
  }

  /** Each step is idempotent, so a retry repeats only what has not succeeded. */
  private async bringUp(): Promise<void> {
    await this.installer.install();
    await this.daemon.start();
    await this.connection.apply();
    this.mcpEndpoint = await this.mcp.find(this.stopping.signal);
    this.announceRunning(this.mcpEndpoint);
  }
}
