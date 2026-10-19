import { chmod, mkdir, rm } from "node:fs/promises";
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

/** Names of the files the publisher writes in its folder. */
export interface FleetClientFiles {
  /** The gateway session's client address, `FLEET_GATEWAY`. */
  readonly address: string;
  /** fleetd's bearer token, `FLEET_TOKEN`. */
  readonly token: string;
}

/**
 * Publish what teammates' `fleet` commands need to reach fleetd, to a folder that teammate pods
 * mount read-only: the address of the gateway session fleetd registered, read from its session file,
 * and fleetd's own bearer token, read from its home. The token is the one fleetd already had, which
 * its existing clients keep using, or the one it minted in a fresh home; it is readable only by the
 * account Everything and teammate pods share. The session file's secrets never leave Fleet's home.
 * With a stable gateway signing key and fleetd's persisted session, the address survives gateway and
 * Everything restarts; if the gateway ever hands out a new address, or fleetd a new token, the next
 * read publishes it, and each new command uses it.
 */
export class FleetClientPublisher {
  // ===========================================
  // Construction and state
  // ===========================================

  private readonly stopping = new AbortController();
  private publishing: Promise<void> | undefined;
  private published: string | undefined;
  private publishedToken: string | undefined;

  /** Publish into `folder`, as `files`, fleetd's token and the session it registered with `gatewayUrl`. */
  constructor(
    private readonly home: Pick<FleetHome, "gatewaySession" | "mcpToken">,
    private readonly gatewayUrl: string,
    private readonly folder: string,
    private readonly files: FleetClientFiles,
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

  /** Stop reading fleetd's files; what was last published stays for the next start. */
  async close(): Promise<void> {
    this.stopping.abort();
    await this.publishing;
  }

  // ===========================================
  // Publishing
  // ===========================================

  /** Publish whenever the token or the session's address changes, reporting failures and trying again later. */
  private async run(): Promise<void> {
    const { signal } = this.stopping;
    while (!signal.aborted) {
      try {
        await this.publishToken();
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

  /**
   * Write the session's address when fleetd has one for this gateway and it is not yet published, and
   * withdraw it when fleetd's session is for another gateway or gone, so commands report that Fleet
   * isn't connected instead of dialing a stale address.
   */
  private async publish(): Promise<void> {
    const file = path.join(this.folder, this.files.address);
    const content = await readOptional(this.home.gatewaySession);
    let session: unknown;
    try {
      session = content === undefined ? undefined : JSON.parse(content);
    } catch {
      // fleetd replaces the file atomically; an unreadable one waits for its next registration.
      return;
    }
    const address = publishedGatewayAddress(session, this.gatewayUrl);
    if (!address) {
      await rm(file, { force: true });
      this.published = undefined;
      return;
    }
    if (address === this.published) return;
    await replaceFile(file, `${address}\n`, {
      directory: 0o755,
      file: 0o644,
    });
    this.published = address;
  }

  /**
   * Publish fleetd's token before any address, so a published address always has its token beside
   * it. fleetd writes the token before it registers and keeps it across restarts; without one yet,
   * nothing is published.
   */
  private async publishToken(): Promise<void> {
    const file = path.join(this.folder, this.files.token);
    const token = (await readOptional(this.home.mcpToken))?.trim();
    if (!token) {
      await rm(file, { force: true });
      this.publishedToken = undefined;
      return;
    }
    if (token === this.publishedToken) return;
    await replaceFile(file, token, { directory: 0o755, file: 0o600 });
    this.publishedToken = token;
  }
}
