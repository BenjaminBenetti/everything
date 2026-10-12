import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ArtifactFile } from "@everything/artifact-contracts";
import { WorkspacePathError } from "../error/workspace-errors.js";
import {
  isInside,
  isInsideAny,
  privatePathMessage,
  realTarget,
} from "./workspace-path.js";

/** How source files are written into a directory. */
export interface CheckoutOptions {
  /** Replace files that share a path in a non-empty directory. */
  readonly overwrite: boolean;
  /** The teammate's private runtime state, never written into, even through symbolic links. */
  readonly privateDirectory?: string;
}

/** Whether a directory is missing or empty. */
async function isEmpty(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).length === 0;
  } catch {
    return true;
  }
}

/** Resolve a source file's path inside the target, refusing any path that would leave it. */
function destination(target: string, file: ArtifactFile): string {
  const resolved = path.resolve(target, file.path);
  const relative = path.relative(target, resolved);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    file.path.includes("\0")
  )
    throw new WorkspacePathError(
      `The source contains an unsafe path, "${file.path}".`,
    );
  return resolved;
}

/**
 * Refuse a destination whose directory resolves outside `root`, the target's real path, or that
 * resolves into the private directory.
 */
async function checkDestination(
  root: string,
  privateDirectories: readonly string[],
  filePath: string,
  file: ArtifactFile,
): Promise<void> {
  if (await isInsideAny(privateDirectories, filePath))
    throw new WorkspacePathError(privatePathMessage(file.path));
  if (!isInside(root, await realTarget(path.dirname(filePath))))
    throw new WorkspacePathError(
      `"${file.path}" would be written through a symbolic link.`,
    );
}

/**
 * Write an artifact's source files into a workspace directory, verifying each file's hash. The
 * directory must be empty unless `overwrite` allows replacing files that share a path. Every
 * destination is checked before any file is written.
 */
export async function checkoutFiles(
  target: string,
  files: readonly ArtifactFile[],
  read: (hash: string) => Promise<Readable>,
  options: CheckoutOptions,
): Promise<void> {
  const privateDirectories =
    options.privateDirectory === undefined ? [] : [options.privateDirectory];
  if (await isInsideAny(privateDirectories, target))
    throw new WorkspacePathError(
      "The directory can't be used. Private conversation files are unavailable.",
    );
  if (!options.overwrite && !(await isEmpty(target)))
    throw new WorkspacePathError(
      "The directory is not empty. Choose an empty directory, or pass overwrite: true to replace files with the same paths.",
    );
  const planned = await realTarget(target);
  const destinations = files.map((file) => destination(target, file));
  for (const [index, file] of files.entries())
    await checkDestination(
      planned,
      privateDirectories,
      destinations[index]!,
      file,
    );
  await mkdir(target, { recursive: true });
  const root = await realpath(target);
  for (const [index, file] of files.entries()) {
    const filePath = destinations[index]!;
    await mkdir(path.dirname(filePath), { recursive: true });
    // Check again now the directories exist, in case links changed since the first check.
    await checkDestination(root, privateDirectories, filePath, file);
    const existing = await lstat(filePath).catch(() => undefined);
    if (existing?.isDirectory())
      throw new WorkspacePathError(
        `"${file.path}" is a directory in the workspace.`,
      );
    const temporary = path.join(
      path.dirname(filePath),
      `.checkout-${randomUUID()}`,
    );
    const hash = createHash("sha256");
    const hashing = new Transform({
      /** Hash each chunk on its way to disk. */
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        await read(file.sha256),
        hashing,
        createWriteStream(temporary),
      );
      if (hash.digest("hex") !== file.sha256)
        throw new Error(
          `"${file.path}" did not match its hash while downloading.`,
        );
      await chmod(temporary, file.executable ? 0o755 : 0o644);
      // Renaming replaces a symbolic link at the destination instead of writing through it.
      await rename(temporary, filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
