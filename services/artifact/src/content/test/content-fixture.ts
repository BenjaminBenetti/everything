import { createHash } from "node:crypto";
import { Readable } from "node:stream";

/** Size of the one chunk generated content is streamed from. */
const chunkSize = 1024 * 1024;

/** `size` bytes as slices of one reused chunk of `byte`. */
function* chunks(size: number, byte: number): Generator<Buffer> {
  const chunk = Buffer.alloc(Math.min(chunkSize, size), byte);
  for (let left = size; left > 0; left -= chunk.length)
    yield left < chunk.length ? chunk.subarray(0, left) : chunk;
}

/**
 * `size` bytes that all equal `byte`, streamed from one reused chunk, so tests move hundreds of MiB
 * without holding them in memory.
 */
export function repeated(size: number, byte = 0): Readable {
  return Readable.from(chunks(size, byte), { objectMode: false });
}

/** The SHA-256 of `repeated(size, byte)`. */
export function repeatedHash(size: number, byte = 0): string {
  const hash = createHash("sha256");
  for (const chunk of chunks(size, byte)) hash.update(chunk);
  return hash.digest("hex");
}
