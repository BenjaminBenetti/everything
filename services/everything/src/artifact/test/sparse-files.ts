import { createHash } from "node:crypto";
import { truncate, writeFile } from "node:fs/promises";

/** Size of the zero chunk sparse content is hashed in. */
const chunkSize = 1024 * 1024;

/**
 * Write a sparse file of `size` bytes: `prefix`, then zeros the file system stores as a hole, so a
 * test can read and upload hundreds of MiB without the disk space or memory for them.
 */
export async function sparse(
  file: string,
  size: number,
  prefix = "",
): Promise<void> {
  await writeFile(file, prefix);
  await truncate(file, size);
}

/** The SHA-256 of a file `sparse` wrote, computed from a reused zero chunk. */
export function sparseHash(size: number, prefix = ""): string {
  const hash = createHash("sha256").update(prefix);
  const zeros = Buffer.alloc(chunkSize);
  for (let left = size - Buffer.byteLength(prefix); left > 0; left -= chunkSize)
    hash.update(left < chunkSize ? zeros.subarray(0, left) : zeros);
  return hash.digest("hex");
}
