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
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new WorkspacePathError(
      `The source contains an unsafe path, "${file.path}".`,
    );
  return resolved;
}

/**
 * Write an artifact's source files into a workspace directory, verifying each file's hash. The
 * directory must be empty unless `overwrite` allows replacing files that share a path.
 */
export async function checkoutFiles(
  target: string,
  files: readonly ArtifactFile[],
  read: (hash: string) => Promise<Readable>,
  overwrite: boolean,
): Promise<void> {
  if (!overwrite && !(await isEmpty(target)))
    throw new WorkspacePathError(
      "The directory is not empty. Choose an empty directory, or pass overwrite: true to replace files with the same paths.",
    );
  await mkdir(target, { recursive: true });
  const root = await realpath(target);
  for (const file of files) {
    const filePath = destination(target, file);
    await mkdir(path.dirname(filePath), { recursive: true });
    const parent = path.relative(root, await realpath(path.dirname(filePath)));
    if (parent.startsWith("..") || path.isAbsolute(parent))
      throw new WorkspacePathError(
        `"${file.path}" would be written through a symbolic link.`,
      );
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
