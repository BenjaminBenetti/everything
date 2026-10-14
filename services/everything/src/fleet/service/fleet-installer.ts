import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import pRetry, { AbortError } from "p-retry";
import {
  fleetReleaseFiles,
  type FleetArchitecture,
  type FleetReleaseFile,
} from "../model/fleet-release-files.js";
import type { FleetRelease } from "../model/fleet-settings.js";

/** Fetch one release file; the global fetch, which follows GitHub's redirects to its file storage. */
export type ReleaseDownload = (url: string) => Promise<Response>;

/**
 * Install the pinned Fleet release into fleetd's binary directory. A file is downloaded only when the
 * installed one is missing or differs, and replaces it only once its SHA-256 matches the chart's pin.
 */
export class FleetInstaller {
  /** Install `release` into `directory` for a container of `architecture`. */
  constructor(
    private readonly release: FleetRelease,
    private readonly directory: string,
    private readonly architecture: FleetArchitecture,
    private readonly download: ReleaseDownload = fetch,
  ) {}

  /** Bring every release file up to date with its pinned checksum. */
  async install(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of fleetReleaseFiles(this.architecture)) {
      const checksum = this.release.checksums[file.asset];
      if (!checksum)
        throw new Error(`The chart pins no checksum for ${file.asset}.`);
      const target = path.join(this.directory, file.installName);
      if ((await fileChecksum(target)) === checksum) continue;
      await pRetry(() => this.replace(file, checksum, target), {
        retries: 3,
      });
    }
  }

  /** Download one file beside its target, check it, then move it into place in one step. */
  private async replace(
    file: FleetReleaseFile,
    checksum: string,
    target: string,
  ): Promise<void> {
    const url = `${this.release.url}/${encodeURIComponent(this.release.version)}/${file.asset}`;
    const response = await this.download(url);
    if (!response.ok)
      throw new Error(
        `Downloading ${file.asset} of Fleet ${this.release.version} failed with HTTP ${response.status}.`,
      );
    const content = Buffer.from(await response.arrayBuffer());
    const actual = createHash("sha256").update(content).digest("hex");
    // A different file under the pinned name is not a transient failure: never retry or install it.
    if (actual !== checksum)
      throw new AbortError(
        `${file.asset} of Fleet ${this.release.version} has SHA-256 ${actual}, not the pinned ${checksum}.`,
      );
    const partial = `${target}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, content, { mode: 0o700 });
      await rename(partial, target);
    } finally {
      await rm(partial, { force: true });
    }
  }
}

/** SHA-256 of a file in hex, or undefined when there is no file. */
async function fileChecksum(file: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return hash.digest("hex");
}
