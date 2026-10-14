import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import pRetry from "p-retry";
import { accepts } from "../adapter/listener-probe.js";

/** A run at least this long counts as healthy, so the next restart starts the backoff over. */
const healthyRunMs = 60_000;
/** Time fleetd gets to end its streams and flush its sync after SIGTERM. */
const stopGraceMs = 20_000;
/** Time fleetd gets to start listening on its socket. */
const startTimeoutMs = 60_000;

/**
 * Keep `fleet server` running as a child of Everything, restarting it with backoff when it exits on
 * its own and stopping it with Everything. Fleet's clients dial its socket; one that finds no daemon
 * starts one itself, which this supervisor then waits behind until it exits.
 */
export class FleetDaemon {
  // ===========================================
  // Construction and state
  // ===========================================

  private readonly stopping = new AbortController();
  private child: ChildProcess | undefined;
  private supervising: Promise<void> | undefined;

  /** Run `executable server` in `environment`, where it listens on `socket`. */
  constructor(
    private readonly executable: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly socket: string,
    private readonly reportFailure: (error: unknown) => void,
  ) {}

  // ===========================================
  // Lifecycle
  // ===========================================

  /** Start supervising fleetd, resolving once a daemon accepts connections on the socket. */
  async start(): Promise<void> {
    this.supervising ??= this.supervise();
    const deadline = Date.now() + startTimeoutMs;
    while (!(await accepts(this.socket))) {
      this.stopping.signal.throwIfAborted();
      if (Date.now() > deadline)
        throw new Error("fleetd did not start listening on its socket.");
      await sleep(250);
    }
  }

  /** Stop fleetd, killing it if it is still running after the grace period. */
  async close(): Promise<void> {
    this.stopping.abort();
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      const kill = setTimeout(() => child.kill("SIGKILL"), stopGraceMs);
      child.kill("SIGTERM");
      await exited;
      clearTimeout(kill);
    }
    await this.supervising;
  }

  // ===========================================
  // Supervision
  // ===========================================

  /** Restart fleetd until close: with growing delays while it keeps failing, at once after a healthy run. */
  private async supervise(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      await pRetry(() => this.runOnce(), {
        retries: Infinity,
        maxTimeout: 60_000,
        signal: this.stopping.signal,
        // After close, the abort itself arrives as a failed attempt.
        onFailedAttempt: ({ error }) => {
          if (!this.stopping.signal.aborted) this.reportFailure(error);
        },
      }).catch(() => undefined);
    }
  }

  /** Run fleetd until it exits; fail when a run ends early on its own, so the restart backs off. */
  private async runOnce(): Promise<void> {
    if (this.stopping.signal.aborted) return;
    const started = Date.now();
    // Everything's umask keeps its own files private. fleetd gets the usual one, so the checkouts
    // and images it builds keep the permissions their projects expect; Fleet makes its secrets private.
    const child = spawn(
      "/bin/sh",
      ["-c", 'umask 022 && exec "$0" server', this.executable],
      { env: this.environment, stdio: ["ignore", "inherit", "inherit"] },
    );
    this.child = child;
    const [code, signal] = await new Promise<
      [number | null, NodeJS.Signals | null]
    >((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, exitSignal) =>
        resolve([exitCode, exitSignal]),
      );
    }).finally(() => {
      this.child = undefined;
    });
    if (this.stopping.signal.aborted) return;
    const error = new Error(
      `fleetd exited with ${signal ?? `code ${code}`}; restarting it.`,
    );
    if (Date.now() - started < healthyRunMs) throw error;
    this.reportFailure(error);
  }
}
