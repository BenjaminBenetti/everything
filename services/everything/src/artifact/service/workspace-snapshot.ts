import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Ignore } from "@balena/dockerignore";
import {
  artifactLimits,
  type ArtifactFile,
} from "@everything/artifact-contracts";
import { SnapshotLimitError } from "../error/workspace-errors.js";

/** A file to upload, with where it lives in the workspace. */
export interface SnapshotFile extends ArtifactFile {
  readonly absolutePath: string;
}

/** The files of a directory, ready to upload as a revision or build source. */
export interface Snapshot {
  readonly files: readonly SnapshotFile[];
  readonly totalSize: number;
  /** Symbolic links and special files, which are never uploaded. */
  readonly skipped: readonly string[];
}

/** How a directory is read. */
export interface SnapshotOptions {
  /** Apply the directory's `.dockerignore`, as a Docker build context does. */
  readonly dockerignore: boolean;
  /** Relative paths always included, such as the Dockerfile, even when ignored. */
  readonly alwaysInclude?: readonly string[];
  /** Absolute directories never included, such as the teammate's private runtime state. */
  readonly exclude?: readonly string[];
}

/** Docker's ignore-file matcher; its typings declare a default export, but it sets `module.exports`. */
const ignore = createRequire(import.meta.url)(
  "@balena/dockerignore",
) as () => Ignore;

/** Directories that never belong in an artifact. */
const neverIncluded = new Set([".git"]);

/** Hash a file's content. */
async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** A directory's `.dockerignore` rules, and whether any rule re-includes paths with `!`. */
interface IgnoreRules {
  readonly matcher: Ignore;
  readonly negated: boolean;
}

/** Read `.dockerignore` rules, if the directory has the file. */
async function dockerignoreRules(
  root: string,
): Promise<IgnoreRules | undefined> {
  const text = await readFile(path.join(root, ".dockerignore"), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return undefined;
  const rules = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return {
    matcher: ignore().add(rules),
    negated: rules.some((rule) => rule.startsWith("!")),
  };
}

/** List, hash, and size every file under `root`, enforcing the artifact limits. */
export async function snapshotDirectory(
  root: string,
  options: SnapshotOptions,
): Promise<Snapshot> {
  const rules = options.dockerignore
    ? await dockerignoreRules(root)
    : undefined;
  const always = new Set(options.alwaysInclude ?? []);
  const excluded = new Set(
    (options.exclude ?? []).map((directory) => path.resolve(directory)),
  );
  // Ignored directories can be skipped whole unless a negated rule might bring part of one back.
  const prunable = !rules?.negated;
  const files: SnapshotFile[] = [];
  const skipped: string[] = [];
  let totalSize = 0;

  /** Walk one directory, adding its files in name order. */
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = [];
    for await (const entry of await opendir(directory)) entries.push(entry);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relative = prefix + entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (neverIncluded.has(entry.name) || excluded.has(absolute)) continue;
        if (prunable && rules?.matcher.ignores(relative)) continue;
        await walk(absolute, `${relative}/`);
      } else if (entry.isFile()) {
        if (rules?.matcher.ignores(relative) && !always.has(relative)) continue;
        const info = await stat(absolute);
        if (info.size > artifactLimits.fileSize)
          throw new SnapshotLimitError(
            `"${relative}" is larger than ${artifactLimits.fileSize / (1024 * 1024)} MiB.`,
          );
        totalSize += info.size;
        if (totalSize > artifactLimits.totalSize)
          throw new SnapshotLimitError(
            `The files total more than ${artifactLimits.totalSize / (1024 * 1024)} MiB.${options.dockerignore ? " Exclude what the build doesn't need in .dockerignore." : ""}`,
          );
        if (files.length === artifactLimits.fileCount)
          throw new SnapshotLimitError(
            `The directory has more than ${artifactLimits.fileCount} files.${options.dockerignore ? " Exclude what the build doesn't need in .dockerignore." : ""}`,
          );
        files.push({
          path: relative,
          absolutePath: absolute,
          sha256: await sha256(absolute),
          size: info.size,
          executable: (info.mode & 0o111) !== 0,
        });
      } else {
        skipped.push(relative);
      }
    }
  }

  await walk(root, "");
  return { files, totalSize, skipped };
}
