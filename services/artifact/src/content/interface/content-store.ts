import type { Readable } from "node:stream";

/** Stores file content addressed by its SHA-256 hash, shared by every revision and build. */
export interface ContentStore {
  /** Return the hashes, from those given, that are not stored yet. */
  missing(hashes: readonly string[]): Promise<string[]>;
  /** Store content under its hash, rejecting content that hashes differently or is too large. */
  write(hash: string, content: Readable, maxSize: number): Promise<void>;
  /** Open stored content for reading, or report it missing. */
  open(hash: string): Promise<Readable>;
}
