import type { Readable } from "node:stream";

/** Stores file content addressed by its SHA-256 hash, shared by every revision and build. */
export interface ContentStore {
  /** Return the hashes, from those given, that are not stored yet. */
  missing(hashes: readonly string[]): Promise<string[]>;
  /** Return the size in bytes of each stored hash, from those given; absent hashes are left out. */
  sizes(hashes: readonly string[]): Promise<Map<string, number>>;
  /** Store content under its hash, rejecting content that hashes differently or is too large. */
  write(hash: string, content: Readable, maxSize: number): Promise<void>;
  /** Open stored content for reading, or report it missing. */
  open(hash: string): Promise<Readable>;
}
