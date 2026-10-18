import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Make `socketPath`'s directory private to this account and clear a stale socket left there, so a
 * new listener can bind it. The path must be absolute and short enough for a Unix socket address.
 */
export async function preparePrivateSocket(socketPath: string): Promise<void> {
  if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100)
    throw new Error("SSH socket requires a bounded absolute path");
  const directory = path.dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error("SSH socket directory must not be a symlink");
  await chmod(directory, 0o700);
  await removeSocket(socketPath);
}

/** Remove only a socket at `socketPath`, refusing ordinary files and symlinks there. */
export async function removeSocket(socketPath: string): Promise<void> {
  const entry = await lstat(socketPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (!entry) return;
  if (!entry.isSocket()) throw new Error("SSH socket path is not a socket");
  await unlink(socketPath);
}
