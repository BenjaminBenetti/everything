import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readOptional, replaceFile } from "../adapter/private-files.js";
import type { FleetHome } from "../model/fleet-home.js";
import { publishedGatewayAddress } from "../model/fleet-remote.js";

/** How often the session file is read: quickly until fleetd first registers, then to notice changes. */
export interface FleetClientPublishing {
  readonly pendingMs: number;
  readonly publishedMs: number;
}

const defaultPublishing: FleetClientPublishing = {
  pendingMs: 2_000,
  publishedMs: 30_000,
};

/**
 * Publish the address teammates' `fleet` commands dial: the gateway session fleetd registered, read
 * from its session file, written alone to a folder that teammate pods mount read-only. The session
 * file's secrets never leave Fleet's home. With a stable gateway signing key and fleetd's persisted
 * session, the address survives gateway and Everything restarts; if the gateway ever hands out a
 * new one, the next read publishes it, and each new command uses it.
 */
export class FleetClientPublisher {
  // ===========================================
  // Construction and state
  // ===========================================

  private readonly stopping = new AbortController();
  private publishing: Promise<void> | undefined;
  private published: string | undefined;

  /** Publish into `folder` the session fleetd registered with `gatewayUrl`, as `fileName`. */
  constructor(
    private readonly home: Pick<FleetHome, "gatewaySession">,
    private readonly gatewayUrl: string,
    private readonly folder: string,
    private readonly fileName: string,
    private readonly reportFailure: (error: unknown) => void,
    private readonly timing: FleetClientPublishing = defaultPublishing,
  ) {}

  // ===========================================
  // Lifecycle
  // ===========================================

  /**
   * Create the folder before any teammate pod mounts it: a folder Kubernetes created for the mount
   * would belong to root.
   */
  async prepare(): Promise<void> {
    await mkdir(this.folder, { recursive: true });
    await chmod(this.folder, 0o755);
  }

  /** Keep the published address current in the background until close. */
  start(): void {
    this.publishing ??= this.run();
  }

  /** Stop reading the session file; the last published address stays for the next start. */
  async close(): Promise<void> {
    this.stopping.abort();
    await this.publishing;
  }

  // ===========================================
  // Publishing
  // ===========================================

  /** Publish whenever the session's address changes, reporting failures and trying again later. */
  private async run(): Promise<void> {
    const { signal } = this.stopping;
    while (!signal.aborted) {
      try {
        await this.publish();
      } catch (error) {
        this.reportFailure(error);
      }
      await sleep(
        this.published ? this.timing.publishedMs : this.timing.pendingMs,
        undefined,
        { signal },
      ).catch(() => undefined);
    }
  }

  /** Write the session's address when fleetd has one for this gateway and it is not yet published. */
  private async publish(): Promise<void> {
    const content = await readOptional(this.home.gatewaySession);
    if (content === undefined) return;
    let session: unknown;
    try {
      session = JSON.parse(content);
    } catch {
      // fleetd replaces the file atomically; an unreadable one waits for its next registration.
      return;
    }
    const address = publishedGatewayAddress(session, this.gatewayUrl);
    if (!address || address === this.published) return;
    await replaceFile(path.join(this.folder, this.fileName), `${address}\n`, {
      directory: 0o755,
      file: 0o644,
    });
    this.published = address;
  }
}
